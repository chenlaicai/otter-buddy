import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkspaceController } from '@interface-adapters/http/controllers/workspace-controller';
import { ManageWorkspace } from '@usecases/conversation/manage-workspace';
import { NodeWorkspaceGateway } from '@frameworks/file-system/node-workspace-gateway';
import { createTestLogger } from '../../helpers/logger';
import { McpClient, StreamableHttpTransport } from '@earendil-works/pi-mcp';
// @ts-expect-error 独立 Node MJS 扩展没有 d.ts；本测试验证其真实运行时接线。
import { CoLinkToolBridge } from '../../../extensions/colink-agent-app/src/colink-tools.mjs';

const CONVERSATION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TOKEN = `Bearer ${'a'.repeat(43)}`;
let tmpDir: string;
let app: Hono;

function config(url = 'http://127.0.0.1:31131/mcp', authorization = TOKEN) {
  return { mcpServers: { colink_otter_history: { url, headers: { authorization }, exposure: 'direct', timeout: 60 } } };
}

function put(body: unknown) {
  return app.request(`/api/conversations/${CONVERSATION_ID}/workspace/mcp-colink`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-mcp-colink-'));
  const controller = new WorkspaceController(new ManageWorkspace(new NodeWorkspaceGateway(tmpDir)), createTestLogger());
  app = new Hono();
  app.put('/api/conversations/:id/workspace/mcp-colink', c => controller.writeCoLinkMcp(c));
});

afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

describe('PUT workspace/mcp-colink', () => {
  it('writes only the constrained loopback config with owner-only permissions and refreshes its own URL', async () => {
    expect((await put(config())).status).toBe(200);
    const file = path.join(tmpDir, 'workspaces', CONVERSATION_ID, 'mcp.json');
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(config());
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await put(config())).status).toBe(200);
    expect((await put(config('http://127.0.0.1:31132/mcp'))).status).toBe(200);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(config('http://127.0.0.1:31132/mcp'));
  });

  it('tightens permissions on an idempotent rewrite and rejects symlink targets', async () => {
    await put(config());
    const file = path.join(tmpDir, 'workspaces', CONVERSATION_ID, 'mcp.json');
    await fs.chmod(file, 0o644);
    expect((await put(config())).status).toBe(200);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const outside = path.join(tmpDir, 'outside.json');
    await fs.writeFile(outside, JSON.stringify(config()));
    await fs.rm(file);
    await fs.symlink(outside, file);
    expect((await put(config('http://127.0.0.1:31132/mcp'))).status).toBe(409);
    expect(JSON.parse(await fs.readFile(outside, 'utf8'))).toEqual(config());
  });

  it('fails closed on a different workspace token or an unrelated server', async () => {
    await put(config());
    const file = path.join(tmpDir, 'workspaces', CONVERSATION_ID, 'mcp.json');
    expect((await put(config(undefined, `Bearer ${'b'.repeat(43)}`))).status).toBe(409);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(config());
    await fs.writeFile(file, JSON.stringify({ mcpServers: { other: {} } }));
    expect((await put(config())).status).toBe(409);
  });

  it('connects App registration, Otter-owned file persistence and a real MCP client', async () => {
    const bridge = new CoLinkToolBridge({ secret: 'integration-secret', port: 0 });
    await bridge.start();
    const calls: Array<{ name: string; args: unknown }> = [];
    const turn = {
      input: { reason: 'mention', text: '读取背景', messageId: 'topic-1', replyToMessageId: null,
        channelId: 'channel-1', topicId: 'topic-1', conversationId: null },
      context: { userId: 'user-1', installationId: 'installation-1', channelId: 'channel-1', topicId: 'topic-1', conversationId: null },
      event: { actor: { id: 'user-1' } },
      tools: {
        list: async () => [{ name: 'colink_read_public_channel', inputSchema: { type: 'object' } }],
        call: async (name: string, args: unknown) => {
          calls.push({ name, args });
          const value = { items: [{ id: 'm1', text: '频道背景' }] };
          return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
        },
      },
      topic: { readPrivate: async () => { throw new Error('unexpected'); } },
    };
    try {
      await bridge.run({ otterConversationId: CONVERSATION_ID, turn, register: async (value: unknown) => {
        expect((await put(value)).status).toBe(200);
      } }, async () => {
        const file = path.join(tmpDir, 'workspaces', CONVERSATION_ID, 'mcp.json');
        const saved = JSON.parse(await fs.readFile(file, 'utf8')).mcpServers.colink_otter_history;
        const client = new McpClient({ name: 'workspace-mcp-integration', version: '1.0.0' });
        await client.connect(new StreamableHttpTransport({ url: saved.url, headers: saved.headers }));
        expect((await client.listTools()).map(tool => tool.name)).toEqual(['colink_read_public_channel']);
        const result = await client.callTool('colink_read_public_channel', { channelId: 'channel-1', beforeMessageId: 'topic-1' });
        expect(result.structuredContent).toEqual({ items: [{ id: 'm1', text: '频道背景' }] });
        await client.close();
      });
      expect(calls).toEqual([{ name: 'colink_read_public_channel', args: { channelId: 'channel-1', beforeMessageId: 'topic-1' } }]);
    } finally { await bridge.close(); }
  });

  it('rejects a global server that would shadow this integration', async () => {
    const sessions = path.join(tmpDir, 'sessions');
    await fs.mkdir(sessions, { recursive: true });
    await fs.writeFile(path.join(sessions, 'mcp.json'), JSON.stringify(config('http://127.0.0.1:9999/mcp')));
    expect((await put(config())).status).toBe(409);
  });

  it('rejects commands, external URLs, other servers and malformed bearer tokens', async () => {
    const external = config('https://example.com/mcp');
    expect((await put(external)).status).toBe(400);
    expect((await put(config(undefined, 'Bearer secret'))).status).toBe(400);
    expect((await put({ mcpServers: { other: {} } })).status).toBe(400);
    expect((await put({ mcpServers: { colink_otter_history: { command: 'node', args: ['x'] } } })).status).toBe(400);
  });
});
