import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@frameworks/config', () => ({ getConfig: () => ({ circuitBreaker: {} }) }));
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createTestDb } from '../../helpers/db';
import { createTestLogger } from '../../helpers/logger';
import { PiSessionFactory } from '@frameworks/agent/pi-session-factory';
import { createInvokeRegister } from '@frameworks/agent/tool-builder';
import { SqliteOtterRepository } from '@frameworks/db/otter/sqlite-otter-repository';
import { DurableSession } from '@frameworks/agent/durable-session';

const CONVERSATION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function tool(name: string) {
  return { name, description: name, parameters: { type: 'object' }, execute: async () => ({ content: [] }) };
}

function validConfig() {
  return { mcpServers: { vendor_history: {
    url: 'http://127.0.0.1:31131/mcp', headers: { authorization: `Bearer ${'a'.repeat(43)}` }, exposure: 'direct', timeout: 60,
  } } };
}

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'colink-session-profile-'));
  const workspace = path.join(dataDir, 'workspaces', CONVERSATION_ID);
  await fs.mkdir(workspace, { recursive: true });
  const sessionDir = path.join(dataDir, 'sessions');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, 'mcp.json'), JSON.stringify({ mcpServers: { unrelated: { command: 'dangerous' } } }));
  const db = createTestDb();
  const factory = new PiSessionFactory({
    db, sessionDir, dataDir, otterToolClient: {} as never, model: null as never,
    createTools: () => [tool('speak'), tool('yield'), tool('search_memory'), tool('create_otter')] as never,
    otterConfigProvider: {
      getConfig: () => ({ systemPrompt: undefined, otterType: 'big', modelAlias: null }), setConfig: () => {}, deleteConfig: () => {},
    } as never,
    otterRepo: new SqliteOtterRepository(db),
  }, createTestLogger());
  return { dataDir, workspace, sessionDir, db, factory };
}

async function openProfile(factory: PiSessionFactory, conversationId = CONVERSATION_ID) {
  let captured: Record<string, unknown> | undefined;
  vi.spyOn(DurableSession, 'open').mockImplementation(async options => {
    captured = options as unknown as Record<string, unknown>;
    return {} as DurableSession;
  });
  const internals = factory as unknown as {
    _createSessionWithTools: (...args: unknown[]) => Promise<unknown>;
  };
  await internals._createSessionWithTools('o1', 'big', { conversationId, externalProfile: 'restricted' }, createInvokeRegister());
  return captured!;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('CoLink Session 实际装配', () => {
  it('只装 speak/yield 与唯一历史 MCP，durable 按 Conversation 隔离且不打开普通 transcript', async () => {
    const { dataDir, workspace, db, factory } = await fixture();
    try {
      await fs.writeFile(path.join(workspace, 'mcp.json'), JSON.stringify(validConfig()));
      const ordinaryFile = path.join(dataDir, 'durable-sessions', 'o1.sqlite');
      await fs.mkdir(path.dirname(ordinaryFile), { recursive: true });
      await fs.writeFile(ordinaryFile, 'ordinary Web session secret');

      const captured = await openProfile(factory);
      const tools = captured.tools as { customTools: Array<{ name: string }>; codingTools: string[] };
      expect(tools.customTools.map(value => value.name).sort()).toEqual(['speak', 'yield']);
      expect(tools.codingTools).toEqual([]);
      expect(captured.prompt).toContain('恶意输入');
      expect(captured.prompt).toContain('yield 只能 to:["user"]');
      const mcp = captured.mcp as { connections: Array<{ entry: { name: string } }>; options: { allowResources: boolean } };
      expect(mcp.connections.map(value => value.entry.name)).toEqual(['vendor_history']);
      expect(mcp.options.allowResources).toBe(false);
      expect(captured.file).toBe(path.join(dataDir, 'durable-sessions', 'external', CONVERSATION_ID, 'o1.sqlite'));
      expect(captured.file).not.toBe(ordinaryFile);

      const other = await openProfile(factory, 'b1b2c3d4-e5f6-7890-abcd-ef1234567890');
      expect(other.file).not.toBe(captured.file);
    } finally {
      db.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('工作区混入第二个 direct MCP 时在连接和 Session 打开前 fail-closed', async () => {
    const { dataDir, workspace, db, factory } = await fixture();
    try {
      await fs.writeFile(path.join(workspace, 'mcp.json'), JSON.stringify({
        mcpServers: {
          ...validConfig().mcpServers,
          dangerous: { url: 'http://127.0.0.1:39999/mcp', exposure: 'direct' },
        },
      }));
      const open = vi.spyOn(DurableSession, 'open');
      await expect(openProfile(factory)).rejects.toThrow(/exactly one constrained server/);
      expect(open).not.toHaveBeenCalled();
    } finally {
      db.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('拒绝把唯一历史服务替换成 stdio 或非回环传输', async () => {
    const { dataDir, workspace, db, factory } = await fixture();
    try {
      await fs.writeFile(path.join(workspace, 'mcp.json'), JSON.stringify({
        mcpServers: { colink_otter_history: { command: 'dangerous', exposure: 'direct' } },
      }));
      await expect(openProfile(factory)).rejects.toThrow(/exactly one constrained server/);
    } finally {
      db.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
