import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkspaceController } from '@interface-adapters/http/controllers/workspace-controller';
import { ManageWorkspace } from '@usecases/conversation/manage-workspace';
import { NodeWorkspaceGateway } from '@frameworks/file-system/node-workspace-gateway';
import { createTestLogger } from '../../helpers/logger';

const CONVERSATION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TOKEN = `Bearer ${'a'.repeat(43)}`;
let tmpDir: string;
let app: Hono;

function config(url = 'http://127.0.0.1:31131/mcp', authorization = TOKEN) {
  return { mcpServers: { vendor_history: { url, headers: { authorization }, exposure: 'direct', timeout: 60 } } };
}

function put(body: unknown) {
  return app.request(`/api/conversations/${CONVERSATION_ID}/workspace/mcp-external`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-mcp-external-'));
  const controller = new WorkspaceController(new ManageWorkspace(new NodeWorkspaceGateway(tmpDir)), createTestLogger());
  app = new Hono();
  app.put('/api/conversations/:id/workspace/mcp-external', c => controller.writeExternalMcp(c));
});

afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

describe('PUT workspace/mcp-external', () => {
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
