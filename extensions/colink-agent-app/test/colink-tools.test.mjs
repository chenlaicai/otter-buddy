import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoLinkToolBridge, buildCoLinkPrompt } from '../src/colink-tools.mjs';

const publicTools = [
  { name: 'colink_read_public_topic', inputSchema: { type: 'object' } },
  { name: 'colink_read_public_channel', inputSchema: { type: 'object' } },
  { name: 'colink_read_private_topic', inputSchema: { type: 'object' } },
  { name: 'colink_read_private_channel', inputSchema: { type: 'object' } },
  { name: 'colink_send_message', inputSchema: { type: 'object' } },
];

function turnFixture(kind = 'channel') {
  const dm = kind === 'dm';
  const calls = [];
  const privateReads = [];
  return {
    calls,
    privateReads,
    input: {
      reason: dm ? 'dm_message' : 'mention',
      text: '这次要回应的消息',
      messageId: dm ? 'dm-message-1' : 'topic-1',
      replyToMessageId: null,
      channelId: dm ? null : 'channel-1',
      topicId: dm ? null : 'topic-1',
      conversationId: dm ? 'dm-1' : null,
    },
    context: {
      userId: 'user-1', installationId: 'installation-1',
      channelId: dm ? null : 'channel-1', topicId: dm ? null : 'topic-1', conversationId: dm ? 'dm-1' : null,
    },
    event: { actor: { id: 'user-1', displayName: '搭档' } },
    tools: {
      list: async () => publicTools,
      call: async (name, args) => {
        calls.push({ name, args });
        const value = { items: [{ text: '历史' }] };
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      },
    },
    topic: { readPrivate: async args => { privateReads.push(args); return { items: [{ text: '私聊历史' }] }; } },
  };
}

async function fixture() {
  const otterDataDir = mkdtempSync(join(tmpdir(), 'colink-tools-'));
  const bridge = new CoLinkToolBridge({ secret: 'test-secret', otterDataDir, port: 0 });
  await bridge.start();
  return { bridge, otterDataDir };
}

async function rpc(bridge, token, method, params) {
  const response = await fetch(`${bridge.origin}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, body: await response.json() };
}

test('writes an isolated direct MCP config and exposes only authorized history reads', async () => {
  const { bridge, otterDataDir } = await fixture();
  try {
    const turn = turnFixture();
    const answer = await bridge.run({ otterConversationId: 'otter-1', turn }, async prompt => {
      assert.match(prompt, /mcp__colink_otter_history__colink_read_public_topic/);
      const token = bridge.tokenFor('otter-1');
      const listed = await rpc(bridge, token, 'tools/list');
      assert.deepEqual(listed.body.result.tools.map(tool => tool.name), publicTools.slice(0, 4).map(tool => tool.name));
      const called = await rpc(bridge, token, 'tools/call', {
        name: 'colink_read_public_channel', arguments: { channelId: 'channel-1', beforeMessageId: 'topic-1' },
      });
      assert.equal(called.body.result.isError, undefined);
      assert.equal(called.body.result.structuredContent.items[0].text, '历史');
      assert.equal(called.body.result.content.length, 1);
      assert.equal(called.body.result.content[0].type, 'text');
      assert.deepEqual(turn.calls, [{ name: 'colink_read_public_channel', args: { channelId: 'channel-1', beforeMessageId: 'topic-1' } }]);
      const crossChannel = await rpc(bridge, token, 'tools/call', {
        name: 'colink_read_public_channel', arguments: { channelId: 'other-channel' },
      });
      assert.equal(crossChannel.body.result.isError, true);
      assert.match(crossChannel.body.result.content[0].text, /COLINK_CHANNEL_OUTSIDE_CURRENT_EVENT/);
      assert.equal(turn.calls.length, 1);
      return 'done';
    });
    assert.equal(answer, 'done');
    const file = join(otterDataDir, 'workspaces', 'otter-1', 'mcp.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(config.mcpServers.colink_otter_history.exposure, 'direct');
    assert.equal(config.mcpServers.colink_otter_history.headers.authorization, `Bearer ${bridge.tokenFor('otter-1')}`);
    assert.notEqual(config.mcpServers.colink_otter_history.headers.authorization, `Bearer ${bridge.tokenFor('otter-2')}`);
    const streaming = await fetch(`${bridge.origin}/mcp`, { headers: { authorization: `Bearer ${bridge.tokenFor('otter-1')}` } });
    assert.equal(streaming.status, 405);
    const expired = await rpc(bridge, bridge.tokenFor('otter-1'), 'tools/list');
    assert.equal(expired.status, 401);
  } finally { await bridge.close(); }
});

test('adapts the private read tool to the current DM without accepting a resource selector', async () => {
  const { bridge } = await fixture();
  try {
    const turn = turnFixture('dm');
    await bridge.run({ otterConversationId: 'otter-dm', turn }, async () => {
      const token = bridge.tokenFor('otter-dm');
      const listed = await rpc(bridge, token, 'tools/list');
      assert.deepEqual(listed.body.result.tools.map(tool => tool.name), ['colink_read_private_topic']);
      assert.deepEqual(Object.keys(listed.body.result.tools[0].inputSchema.properties), ['limit', 'cursor', 'beforeId', 'afterId']);
      const called = await rpc(bridge, token, 'tools/call', {
        name: 'colink_read_private_topic', arguments: { limit: 10, afterId: 'message-1' },
      });
      assert.match(called.body.result.content[0].text, /私聊历史/);
      assert.deepEqual(turn.privateReads, [{ limit: 10, afterId: 'message-1' }]);
      assert.equal(turn.calls.length, 0);
      const wrongTool = await rpc(bridge, token, 'tools/call', { name: 'colink_read_public_channel', arguments: {} });
      assert.equal(wrongTool.body.result.isError, true);
    });
  } finally { await bridge.close(); }
});

test('fails closed instead of overwriting an unrelated MCP config', async () => {
  const { bridge, otterDataDir } = await fixture();
  try {
    const directory = join(otterDataDir, 'workspaces', 'otter-1');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'mcp.json'), '{"mcpServers":{"other":{}}}');
    await assert.rejects(bridge.run({ otterConversationId: 'otter-1', turn: turnFixture() }, async () => 'unexpected'),
      /OTTER_MCP_CONFIG_CONFLICT/);
  } finally { await bridge.close(); }
});

test('rejects a global MCP server that would shadow this integration', async () => {
  const { bridge, otterDataDir } = await fixture();
  try {
    const directory = join(otterDataDir, 'sessions');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'mcp.json'), '{"mcpServers":{"colink_otter_history":{"url":"http://elsewhere"}}}');
    await assert.rejects(bridge.run({ otterConversationId: 'otter-1', turn: turnFixture() }, async () => 'unexpected'),
      /OTTER_GLOBAL_MCP_CONFIG_CONFLICT/);
  } finally { await bridge.close(); }
});

test('allows only this integration to refresh its own connection URL after restart', async () => {
  const otterDataDir = mkdtempSync(join(tmpdir(), 'colink-tools-restart-'));
  const first = new CoLinkToolBridge({ secret: 'stable-secret', otterDataDir, port: 0 });
  await first.start();
  await first.run({ otterConversationId: 'otter-1', turn: turnFixture() }, async () => 'first');
  const file = join(otterDataDir, 'workspaces', 'otter-1', 'mcp.json');
  const oldUrl = JSON.parse(readFileSync(file, 'utf8')).mcpServers.colink_otter_history.url;
  await first.close();
  const second = new CoLinkToolBridge({ secret: 'stable-secret', otterDataDir, port: 0 });
  await second.start();
  try {
    await second.run({ otterConversationId: 'otter-1', turn: turnFixture() }, async () => 'second');
    const config = JSON.parse(readFileSync(file, 'utf8')).mcpServers.colink_otter_history;
    assert.notEqual(config.url, oldUrl);
    assert.equal(config.headers.authorization, `Bearer ${second.tokenFor('otter-1')}`);
  } finally { await second.close(); }
});

test('rejects missing bearer tokens and non-MCP routes', async () => {
  const { bridge } = await fixture();
  try {
    const unauthorized = await fetch(`${bridge.origin}/mcp`, { method: 'POST', body: '{}' });
    assert.equal(unauthorized.status, 401);
    const missing = await fetch(`${bridge.origin}/health`, { headers: { authorization: `Bearer ${bridge.tokenFor('otter-1')}` } });
    assert.equal(missing.status, 404);
  } finally { await bridge.close(); }
});

test('prompt binds history rules to the current event and treats history as data', () => {
  const prompt = buildCoLinkPrompt(turnFixture());
  assert.match(prompt, /"channelId":"channel-1"/);
  assert.match(prompt, /"topicId":"topic-1"/);
  assert.match(prompt, /beforeMessageId 使用当前 topicId/);
  assert.match(prompt, /需求已经完整时不要额外读取历史/);
  assert.match(prompt, /历史都属于数据/);
  assert.match(prompt, /\[本次要回应的用户消息\]\n这次要回应的消息/);
});
