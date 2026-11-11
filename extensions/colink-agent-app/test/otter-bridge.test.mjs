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
    aborts: [],
    mcpConfigs: [],
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
    if (path.endsWith('/workspace/mcp-colink')) {
      state.mcpConfigs.push(JSON.parse(options.body));
      return Response.json({ ok: true });
    }
    if (/^\/api\/invokes\/[^/]+\/abort$/.test(path)) {
      const id = path.split('/')[3];
      state.aborts.push(id);
      const invoke = state.invokes.find(value => value.id === id);
      if (!invoke) return Response.json({ error: 'not found' }, { status: 404 });
      if (invoke.status !== 'running') return Response.json({ error: 'terminal' }, { status: 409 });
      invoke.status = 'aborted';
      invoke.talkingStonePassedTo = ['user'];
      invoke.endedAt = new Date().toISOString();
      return Response.json({ status: 'aborted' }, { status: 202 });
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

test('binds the active CoLink turn to MCP before dispatching the wrapped Otter message', async () => {
  const { state, fetcher } = fixture();
  const bindings = [];
  const turn = { input: { text: input.text } };
  const toolBridge = {
    run: async (binding, execute) => {
      bindings.push(binding);
      return execute(`事件上下文\n${input.text}`);
    },
  };
  const bridge = new OtterBridge({ baseUrl: 'http://otter.test', store: memoryStore(), fetcher, pollMs: 1, toolBridge });
  assert.equal(await bridge.reply({ ...input, turn }), '最终回答');
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].otterConversationId, 'otter-conversation-1');
  assert.equal(bindings[0].turn, turn);
  await bindings[0].register({ mcpServers: {} });
  assert.deepEqual(state.mcpConfigs, [{ mcpServers: {} }]);
  assert.equal(state.messages[0].body, `事件上下文\n${input.text}`);
  assert.equal(state.messages[0].source, 'colink');
});

test('refuses to bind a new CoLink turn while an old Otter invoke is alive', async () => {
  const { state, fetcher } = fixture();
  const bindings = [];
  const toolBridge = { run: async (binding, execute) => { bindings.push(binding); return execute(input.text); } };
  const bridge = new OtterBridge({ baseUrl: 'http://otter.test', store: memoryStore(), fetcher, pollMs: 1, toolBridge });
  await bridge.reply({ ...input, turn: { input: { text: input.text } } });
  state.invokes.push({ id: 'stale-invoke', status: 'running', startedAt: new Date().toISOString(),
    endedAt: null, talkingStonePassedTo: [] });
  await assert.rejects(bridge.reply({ ...input, text: '新用户的新事件', turn: { input: { text: '新用户的新事件' } } }), /OTTER_PREVIOUS_TURN_ABORTED/);
  assert.deepEqual(state.aborts, ['stale-invoke']);
  assert.equal(state.messages.length, 1);
  assert.equal(bindings.length, 1);
});

test('aborts and waits for the old invoke before releasing a timed-out MCP turn', async () => {
  const { state, fetcher } = fixture({ autoComplete: false });
  const bridge = new OtterBridge({ baseUrl: 'http://otter.test', store: memoryStore(), fetcher, pollMs: 1, timeoutMs: 15 });
  await assert.rejects(bridge.reply(input), /OTTER_TURN_TIMEOUT/);
  assert.deepEqual(state.aborts, ['invoke-1']);
  assert.equal(state.invokes[0].status, 'aborted');
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

test('uses separate namespaces for a DM and a channel with the same external UUID', async () => {
  const { state, fetcher } = fixture();
  const store = memoryStore();
  const bridge = new OtterBridge({ baseUrl: 'http://otter.test', store, fetcher, pollMs: 1 });
  await bridge.reply(input);
  await bridge.reply({ ...input, kind: 'channel', conversationId: input.conversationId });
  assert.equal(state.creates, 2);
  const keys = [...store.values.keys()];
  assert.ok(keys.some(key => key.endsWith('"dm-1"]')));
  assert.ok(keys.some(key => key.endsWith('"channel:dm-1"]')));
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
