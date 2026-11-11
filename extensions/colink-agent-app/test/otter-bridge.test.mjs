import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore, OtterBridge } from '../src/otter-bridge.mjs';

function memoryStore() {
  const values = new Map();
  return { values, get: key => values.get(key), set: (key, value) => values.set(key, value) };
}

function fixture({ autoComplete = true, otterIds = ['big-otter'] } = {}) {
  const state = {
    creates: 0,
    messages: [],
    entries: [],
    invokes: [],
    cancelled: 0,
    polls: 0,
    completeAfterPolls: 0,
    answer: '最终回答',
  };
  const finish = () => {
    const invoke = state.invokes.at(-1);
    if (!invoke || invoke.status !== 'running') return;
    invoke.status = 'completed';
    invoke.talkingStonePassedTo = ['user'];
    invoke.endedAt = new Date().toISOString();
    state.entries.push({ id: `speak-${state.invokes.length}`, entryType: 'speak', body: state.answer,
      sequenceNum: 100 + state.invokes.length, createdAt: new Date().toISOString() });
  };
  const fetcher = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/api/conversations') {
      state.creates++;
      return Response.json({ id: 'otter-conversation-1', otterIds });
    }
    if (path.endsWith('/messages')) {
      const body = JSON.parse(options.body);
      const now = new Date().toISOString();
      const sequenceNum = state.messages.length * 10 + 1;
      state.messages.push(body);
      state.entries.push({ id: `user-${sequenceNum}`, entryType: 'user', senderId: body.senderId,
        body: body.body, sequenceNum, createdAt: now });
      state.invokes.push({ id: `invoke-${state.messages.length}`, status: 'running', startedAt: now,
        endedAt: null, talkingStonePassedTo: [] });
      if (autoComplete && state.completeAfterPolls === 0) finish();
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('event: stream.end\ndata: {}\n\n')); },
        cancel() { state.cancelled++; },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (path.endsWith('/entries')) {
      state.polls++;
      if (autoComplete && state.completeAfterPolls > 0 && state.polls >= state.completeAfterPolls) finish();
      return Response.json({ entries: state.entries });
    }
    if (path.endsWith('/invokes')) return Response.json({ invokes: [...state.invokes].reverse() });
    throw new Error(`Unexpected ${options.method ?? 'GET'} ${path}`);
  };
  return { state, fetcher, finish };
}

const input = { deploymentId: 'deployment-1', installationId: 'installation-1', conversationId: 'dm-1', actorId: 'user-1', text: '请记住暗号：蓝鲸' };

test('maps a DM to one single-otter conversation, reuses it, and returns only final speak', async () => {
  const { state, fetcher } = fixture();
  const store = memoryStore();
  const bridge = new OtterBridge({ baseUrl: 'http://otter.test/', store, fetcher, pollMs: 1 });
  assert.equal(await bridge.reply(input), '最终回答');
  assert.equal(await bridge.reply({ ...input, text: '暗号是什么？' }), '最终回答');
  assert.equal(state.creates, 1);
  assert.equal(state.messages.length, 2);
  assert.equal(store.values.size, 1);
  assert.equal(state.cancelled, 2);
});

test('isolates deployment, installation, and DM conversation mappings', async () => {
  const { state, fetcher } = fixture();
  const store = memoryStore();
  const bridge = new OtterBridge({ baseUrl: 'http://otter.test', store, fetcher, pollMs: 1 });
  await bridge.reply(input);
  await bridge.reply({ ...input, deploymentId: 'deployment-2' });
  await bridge.reply({ ...input, installationId: 'installation-2' });
  await bridge.reply({ ...input, conversationId: 'dm-2' });
  assert.equal(state.creates, 4);
  assert.equal(store.values.size, 4);
});

test('does not wait for the SSE stream or intermediate polls after a persistent terminal answer', async () => {
  const { state, fetcher } = fixture({ autoComplete: false });
  const bridge = new OtterBridge({ baseUrl: 'http://otter.test', store: memoryStore(), fetcher, pollMs: 1 });
  const pending = bridge.reply(input);
  await new Promise(resolve => setTimeout(resolve, 10));
  state.entries.push({ id: 'progress', entryType: 'speak', body: '正在处理', sequenceNum: 2, createdAt: new Date().toISOString() });
  state.answer = '蓝鲸\n\n<healing>[no_issue]</healing>';
  state.invokes[0].status = 'completed';
  state.invokes[0].talkingStonePassedTo = ['user'];
  state.entries.push({ id: 'final', entryType: 'speak', body: state.answer, sequenceNum: 3, createdAt: new Date().toISOString() });
  assert.equal(await pending, '蓝鲸');
  assert.equal(state.cancelled, 1);
});

test('waits for a yielded invoke chain instead of treating the first completed invoke as final', async () => {
  const { state, fetcher } = fixture({ autoComplete: false });
  const bridge = new OtterBridge({ baseUrl: 'http://otter.test', store: memoryStore(), fetcher, pollMs: 1 });
  const pending = bridge.reply(input);
  await new Promise(resolve => setTimeout(resolve, 10));
  const now = new Date().toISOString();
  state.invokes[0].status = 'completed';
  state.invokes[0].talkingStonePassedTo = ['another-otter'];
  state.invokes.push({ id: 'invoke-next', status: 'running', startedAt: now, endedAt: null, talkingStonePassedTo: [] });
  await new Promise(resolve => setTimeout(resolve, 10));
  state.invokes[1].status = 'completed';
  state.invokes[1].talkingStonePassedTo = ['user'];
  state.entries.push({ id: 'final', entryType: 'speak', body: '链条最终回答', sequenceNum: 2, createdAt: now });
  assert.equal(await pending, '链条最终回答');
});

test('fails closed when execution fails or terminal chain has no final speak', async () => {
  for (const failure of ['failed', 'aborted']) {
    const { state, fetcher } = fixture({ autoComplete: false });
    const bridge = new OtterBridge({ baseUrl: 'http://otter.test', store: memoryStore(), fetcher, pollMs: 1 });
    const pending = bridge.reply(input);
    await new Promise(resolve => setTimeout(resolve, 5));
    state.invokes[0].status = failure;
    await assert.rejects(pending, /OTTER_TURN_FAILED/);
  }
  const { state, fetcher } = fixture({ autoComplete: false });
  const bridge = new OtterBridge({ baseUrl: 'http://otter.test', store: memoryStore(), fetcher, pollMs: 1 });
  const pending = bridge.reply(input);
  await new Promise(resolve => setTimeout(resolve, 5));
  state.invokes[0].status = 'completed';
  state.invokes[0].talkingStonePassedTo = ['user'];
  await assert.rejects(pending, /OTTER_FINAL_SPEAK_MISSING/);
});

test('requires exactly one otter when creating the mapped conversation', async () => {
  const { fetcher } = fixture({ otterIds: ['one', 'two'] });
  const bridge = new OtterBridge({ baseUrl: 'http://otter.test', store: memoryStore(), fetcher });
  await assert.rejects(bridge.reply(input), /OTTER_SINGLE_OTTER_REQUIRED/);
});

test('persists mappings with owner-only file permissions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'otter-bridge-'));
  const file = join(directory, 'nested', 'bindings.json');
  const store = new ConversationStore(file);
  store.set('external', 'otter-conversation');
  assert.equal(new ConversationStore(file).get('external'), 'otter-conversation');
  const content = readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(content), { external: 'otter-conversation' });
});
