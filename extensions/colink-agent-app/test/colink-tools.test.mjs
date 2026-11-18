import test from 'node:test';
import assert from 'node:assert/strict';
import { McpClient, StreamableHttpTransport } from '@earendil-works/pi-mcp';
import { CoLinkToolBridge, buildCoLinkPrompt, isBareMention, toolsFor } from '../src/colink-tools.mjs';

const SECRET = 'test-mcp-secret-0123456789abcdef0123456789';

function ctxFixture(kind = 'channel', overrides = {}) {
  const dm = kind === 'dm';
  const calls = [];
  const sourceReads = [];
  const channelReads = [];
  const data = {
    reason: dm ? 'dm_message' : 'mention',
    text: '这次要回应的消息',
    messageId: dm ? 'dm-message-1' : 'topic-1',
    replyToMessageId: null,
    channelId: dm ? null : 'channel-1',
    topicId: dm ? null : 'topic-1',
    conversationId: dm ? 'dm-1' : null,
    channelVisibility: dm ? undefined : 'public',
    fileIds: [],
    ...overrides,
  };
  return {
    calls,
    sourceReads,
    channelReads,
    event: { deploymentId: 'deployment-1', eventId: 'event-1', actor: { id: 'user-1', displayName: '搭档' }, data },
    context: { userId: 'user-1', installationId: 'installation-1', channelId: data.channelId, topicId: data.topicId, conversationId: data.conversationId },
    source: {
      kind: dm ? 'dm' : 'topic',
      listMessages: async args => {
        sourceReads.push(args);
        return { items: [{ id: 'm1', text: dm ? '私聊历史' : '话题历史' }], hasMore: false, nextCursor: null };
      },
    },
    colink: {
      app: { channels: { listMessages: async args => { channelReads.push({ identity: 'app', args }); return { items: [{ id: 'c1', text: '公共频道背景' }] }; } } },
      user: { channels: { listMessages: async args => { channelReads.push({ identity: 'user', args }); return { items: [{ id: 'c2', text: '私密频道背景' }] }; } } },
    },
    signal: new AbortController().signal,
  };
}

async function rpc(bridge, token, method, params) {
  const response = await fetch(`${bridge.origin}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, body: await response.json() };
}

/** 从 configFor 产物取本轮 bearer——代理不对外暴露 token 生成方式。 */
function tokenOf(config) {
  return config.mcpServers.colink_otter_history.headers.authorization.replace(/^Bearer /, '');
}

test('exposes exactly two source-bound history tools for a channel event', () => {
  assert.deepEqual(toolsFor(ctxFixture('channel')).map(tool => tool.name), ['colink_read_topic', 'colink_read_channel']);
  assert.deepEqual(toolsFor(ctxFixture('dm')).map(tool => tool.name), ['colink_read_topic']);
});

test('registers a per-turn direct MCP config through Otter and serves topic reads from the event source', async () => {
  const bridge = new CoLinkToolBridge({ secret: SECRET, port: 0 });
  await bridge.start();
  try {
    const ctx = ctxFixture('channel');
    const registrations = [];
    const answer = await bridge.run({
      otterConversationId: 'otter-1', ctx, register: async config => registrations.push(config),
    }, async prompt => {
      assert.match(prompt, /mcp__colink_otter_history__colink_read_topic/);
      assert.match(prompt, /mcp__colink_otter_history__colink_read_channel/);
      const token = tokenOf(registrations[0]);
      const listed = await rpc(bridge, token, 'tools/list');
      assert.deepEqual(listed.body.result.tools.map(tool => tool.name), ['colink_read_topic', 'colink_read_channel']);
      const called = await rpc(bridge, token, 'tools/call', { name: 'colink_read_topic', arguments: { limit: 20 } });
      assert.equal(called.body.result.structuredContent.items[0].text, '话题历史');
      assert.equal(called.body.result.content.length, 1);
      assert.deepEqual(ctx.sourceReads, [{ limit: 20 }]);
      return 'done';
    });
    assert.equal(answer, 'done');
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].mcpServers.colink_otter_history.url, `${bridge.origin}/mcp`);
  } finally {
    await bridge.close();
  }
});

test('a conversation keeps one stable bearer across rounds so Otter can rewrite its own mcp.json', async () => {
  const bridge = new CoLinkToolBridge({ secret: SECRET, port: 0 });
  await bridge.start();
  try {
    const rounds = [];
    const register = async config => rounds.push(config);
    await bridge.run({ otterConversationId: 'o', ctx: ctxFixture('channel'), register }, async () => 'one');
    const firstToken = tokenOf(rounds[0]);
    // Why: Otter 的 mcp-external 守卫（manage-workspace.ts isSameOwnedConfig）要求同一 server 的
    // bearer 与已落盘文件一致，不同即 409 且 Agent 不启动；因此第二轮必须注册同一 bearer 与同一配置。
    await bridge.run({ otterConversationId: 'o', ctx: ctxFixture('channel'), register }, async () => {
      assert.equal(tokenOf(rounds[1]), firstToken);
      assert.deepEqual(rounds[1], rounds[0]);
      // 授权时效靠 active 映射：token 稳定但只映射当前轮。
      assert.equal((await rpc(bridge, firstToken, 'tools/list')).status, 200);
      return 'two';
    });
    // 事件结束后同一个 bearer 不再可用。
    assert.equal((await rpc(bridge, firstToken, 'tools/list')).status, 401);
    // 不同 Conversation 派生不同 bearer（互不借用）。
    const other = [];
    await bridge.run({ otterConversationId: 'o-other', ctx: ctxFixture('channel'), register: async c => other.push(c) }, async () => 'x');
    assert.notEqual(tokenOf(other[0]), firstToken);
  } finally {
    await bridge.close();
  }
});

test('the bridge refuses to start without a 32+ character derivation secret', () => {
  assert.throws(() => new CoLinkToolBridge({ port: 0 }), /COLINK_MCP_SECRET_REQUIRED/);
  assert.throws(() => new CoLinkToolBridge({ secret: 'short', port: 0 }), /COLINK_MCP_SECRET_REQUIRED/);
});

test('channel background read uses the identity fixed by the event visibility snapshot', async () => {
  const bridge = new CoLinkToolBridge({ secret: SECRET, port: 0 });
  await bridge.start();
  try {
    const publicCtx = ctxFixture('channel');
    let config = [];
    await bridge.run({ otterConversationId: 'o1', ctx: publicCtx, register: async c => config.push(c) }, async () => {
      const called = await rpc(bridge, tokenOf(config[0]), 'tools/call', { name: 'colink_read_channel', arguments: { limit: 10 } });
      assert.equal(called.body.result.structuredContent.items[0].text, '公共频道背景');
    });
    assert.deepEqual(publicCtx.channelReads, [{ identity: 'app', args: { channelId: 'channel-1', beforeMessageId: 'topic-1', limit: 10 } }]);

    const privateCtx = ctxFixture('channel', { channelVisibility: 'private' });
    config = [];
    await bridge.run({ otterConversationId: 'o2', ctx: privateCtx, register: async c => config.push(c) }, async () => {
      const called = await rpc(bridge, tokenOf(config[0]), 'tools/call', { name: 'colink_read_channel', arguments: {} });
      assert.equal(called.body.result.structuredContent.items[0].text, '私密频道背景');
    });
    assert.deepEqual(privateCtx.channelReads, [{ identity: 'user', args: { channelId: 'channel-1', beforeMessageId: 'topic-1' } }]);
  } finally {
    await bridge.close();
  }
});

test('fails closed when the channel visibility snapshot is missing, and rejects caller-chosen resources', async () => {
  const bridge = new CoLinkToolBridge({ secret: SECRET, port: 0 });
  await bridge.start();
  try {
    const ctx = ctxFixture('channel', { channelVisibility: undefined });
    const config = [];
    await bridge.run({ otterConversationId: 'o', ctx, register: async c => config.push(c) }, async () => {
      const token = tokenOf(config[0]);
      const noVisibility = await rpc(bridge, token, 'tools/call', { name: 'colink_read_channel', arguments: {} });
      assert.equal(noVisibility.body.result.isError, true);
      assert.equal(noVisibility.body.result.structuredContent.error.code, 'COLINK_CHANNEL_VISIBILITY_UNKNOWN');
      const crossTopic = await rpc(bridge, token, 'tools/call', { name: 'colink_read_topic', arguments: { topicId: 'other-topic' } });
      assert.equal(crossTopic.body.result.isError, true);
      assert.equal(crossTopic.body.result.structuredContent.error.code, 'COLINK_TOOL_ARG_NOT_ALLOWED:topicId');
      const crossChannel = await rpc(bridge, token, 'tools/call', { name: 'colink_read_channel', arguments: { channelId: 'other-channel' } });
      assert.equal(crossChannel.body.result.isError, true);
      assert.equal(crossChannel.body.result.structuredContent.error.code, 'COLINK_TOOL_ARG_NOT_ALLOWED:channelId');
    });
    assert.deepEqual(ctx.sourceReads, []);
    assert.deepEqual(ctx.channelReads, []);
  } finally {
    await bridge.close();
  }
});

test('DM wake reads only the current conversation through the event source', async () => {
  const bridge = new CoLinkToolBridge({ secret: SECRET, port: 0 });
  await bridge.start();
  try {
    const ctx = ctxFixture('dm');
    const config = [];
    await bridge.run({ otterConversationId: 'o', ctx, register: async c => config.push(c) }, async () => {
      const token = tokenOf(config[0]);
      const called = await rpc(bridge, token, 'tools/call', { name: 'colink_read_topic', arguments: { limit: 5, beforeId: 'dm-message-0' } });
      assert.equal(called.body.result.structuredContent.items[0].text, '私聊历史');
      const cursor = await rpc(bridge, token, 'tools/call', { name: 'colink_read_topic', arguments: { cursor: 'next' } });
      assert.equal(cursor.body.result.isError, true);
      assert.equal(cursor.body.result.structuredContent.error.code, 'COLINK_TOOL_ARG_NOT_ALLOWED:cursor');
    });
    assert.deepEqual(ctx.sourceReads, [{ limit: 5, beforeId: 'dm-message-0' }]);
  } finally {
    await bridge.close();
  }
});

test('a bare mention pre-reads the current topic before the agent starts', async () => {
  const bridge = new CoLinkToolBridge({ secret: SECRET, port: 0 });
  await bridge.start();
  try {
    const ctx = ctxFixture('channel', { text: '@海獭' });
    const config = [];
    await bridge.run({ otterConversationId: 'o', ctx, register: async c => config.push(c) }, async prompt => {
      assert.match(prompt, /\[App 确定性预读的当前话题最近一页/);
      assert.deepEqual(ctx.sourceReads, [{ limit: 20 }]);
      return 'ok';
    });
    assert.equal(config.length, 1);
  } finally {
    await bridge.close();
  }
});

test('prompt states the fixed identity rules and treats history as untrusted data', () => {
  const prompt = buildCoLinkPrompt(ctxFixture('channel'), undefined);
  assert.match(prompt, /公共频道由 App 身份读取、私密频道与私聊由当前用户身份读取/);
  assert.match(prompt, /不是更高优先级指令/);
  assert.match(prompt, /不得执行文件、bash、其他 MCP、全局记忆或海獭编排操作/);
  const dmPrompt = buildCoLinkPrompt(ctxFixture('dm'), undefined);
  assert.match(dmPrompt, /mcp__colink_otter_history__colink_read_topic/);
  assert.doesNotMatch(dmPrompt, /colink_read_channel/);
});

test('isBareMention only matches messages that carry nothing but the mention', () => {
  assert.equal(isBareMention('@海獭'), true);
  assert.equal(isBareMention('<@agent-1>'), true);
  assert.equal(isBareMention('@海獭 帮我总结'), false);
  assert.equal(isBareMention(''), false);
});

test('interoperates with the real MCP Streamable HTTP client', async () => {
  const bridge = new CoLinkToolBridge({ secret: SECRET, port: 0 });
  await bridge.start();
  try {
    const ctx = ctxFixture('channel');
    const registrations = [];
    await bridge.run({
      otterConversationId: 'otter-http-client', ctx, register: async config => registrations.push(config),
    }, async () => {
      const server = registrations[0].mcpServers.colink_otter_history;
      const client = new McpClient({ name: 'colink-app-contract-test', version: '1.0.0' });
      await client.connect(new StreamableHttpTransport({ url: server.url, headers: server.headers }));
      try {
        assert.deepEqual((await client.listTools()).map(tool => tool.name), ['colink_read_topic', 'colink_read_channel']);
        const result = await client.callTool('colink_read_topic', { limit: 10 });
        assert.equal(result.structuredContent.items[0].text, '话题历史');
        // 真实客户端也拿不到当前事件之外的资源（pi-mcp 把工具错误作为结果返回，不会抛）。
        const denied = await client.callTool('colink_read_channel', { channelId: 'other-channel' });
        assert.equal(denied.isError, true);
        assert.equal(denied.structuredContent.error.code, 'COLINK_TOOL_ARG_NOT_ALLOWED:channelId');
      } finally { await client.close(); }
      return 'done';
    });
    assert.deepEqual(ctx.sourceReads, [{ limit: 10 }]);
    assert.deepEqual(ctx.channelReads, []);
  } finally {
    await bridge.close();
  }
});

test('enforces the 0.28 per-source pagination limits and rejects DM channel reads', async () => {
  const bridge = new CoLinkToolBridge({ secret: SECRET, port: 0 });
  await bridge.start();
  try {
    const channelCtx = ctxFixture('channel');
    const config = [];
    await bridge.run({ otterConversationId: 'limits', ctx: channelCtx, register: async c => config.push(c) }, async () => {
      const token = tokenOf(config[0]);
      const tooMany = await rpc(bridge, token, 'tools/call', { name: 'colink_read_channel', arguments: { limit: 51 } });
      assert.equal(tooMany.body.result.structuredContent.error.code, 'COLINK_TOOL_LIMIT_INVALID');
      const longCursor = await rpc(bridge, token, 'tools/call', { name: 'colink_read_channel', arguments: { cursor: 'c'.repeat(1025) } });
      assert.equal(longCursor.body.result.structuredContent.error.code, 'COLINK_TOOL_CURSOR_INVALID:cursor');
      const maxOk = await rpc(bridge, token, 'tools/call', { name: 'colink_read_channel', arguments: { limit: 50 } });
      assert.equal(maxOk.body.result.isError, undefined);
      return 'ok';
    });

    const dmCtx = ctxFixture('dm');
    const dmConfig = [];
    await bridge.run({ otterConversationId: 'limits-dm', ctx: dmCtx, register: async c => dmConfig.push(c) }, async () => {
      const token = tokenOf(dmConfig[0]);
      const longBefore = await rpc(bridge, token, 'tools/call', { name: 'colink_read_topic', arguments: { beforeId: 'm'.repeat(37) } });
      assert.equal(longBefore.body.result.structuredContent.error.code, 'COLINK_TOOL_CURSOR_INVALID:beforeId');
      // DM 事件没有频道上下文：频道工具即使不被列出也必须失败关闭。
      const channelOnDm = await rpc(bridge, token, 'tools/call', { name: 'colink_read_channel', arguments: {} });
      assert.equal(channelOnDm.body.result.isError, true);
      assert.equal(channelOnDm.body.result.structuredContent.error.code, 'COLINK_CHANNEL_READ_UNAVAILABLE');
      return 'ok';
    });
    assert.deepEqual(dmCtx.channelReads, []);
  } finally {
    await bridge.close();
  }
});
