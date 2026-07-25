import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SessionRestore } from "@frameworks/agent/session-restore";
import { createAgentSessionStore, type AgentSessionStore } from "@frameworks/agent/agent-session-store";
import type { Logger } from "@usecases/ports/logger";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";

function mockLogger(): Logger {
  const logger: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => logger,
  };
  return logger;
}

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.prepare("CREATE TABLE agent_sessions (otter_id TEXT PRIMARY KEY, pi_session_id TEXT, session_file TEXT, updated_at TEXT)").run();
  return db;
}

function makeConfigProvider(): OtterConfigProvider {
  const configs = new Map<string, { systemPrompt?: string; otterType: string }>();
  return {
    getConfig: (id: string) => configs.get(id) ?? null,
    setConfig: (id: string, cfg: { systemPrompt?: string; otterType: string }) => { configs.set(id, cfg); },
    deleteConfig: (id: string) => { configs.delete(id); },
  } as unknown as OtterConfigProvider;
}

let sessionCounter = 0;
function makeFakeSessionManager() {
  const n = ++sessionCounter;
  return {
    getSessionId: () => `sid-${n}`,
    getSessionFile: () => `/tmp/fake-session-${n}.jsonl`,
  };
}

/** open 行为可控的 piCodingAgent mock */
function makePiCodingAgent(openImpl?: (file: string) => unknown) {
  return {
    SessionManager: {
      create: () => makeFakeSessionManager(),
      open: openImpl ?? ((file: string) => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT", path: file }); }),
    },
  };
}

describe("SessionRestore.createdNew 信号", () => {
  let db: Database.Database;
  let store: AgentSessionStore;
  let provider: OtterConfigProvider;
  let restore: SessionRestore;

  beforeEach(() => {
    db = makeDb();
    store = createAgentSessionStore(db);
    provider = makeConfigProvider();
    restore = new SessionRestore(store, provider, mockLogger(), db);
  });

  it("无 session 记录且有配置 → 创建新 session，createdNew=true", async () => {
    provider.setConfig("o1", { otterType: "big" } as never);

    const result = await restore.restoreOrCreate("o1", makePiCodingAgent(), "/tmp/sessions");

    expect(result.sessionManager).not.toBeNull();
    expect(result.createdNew).toBe(true);
  });

  it("无 session 记录且无配置 → 抛错", async () => {
    await expect(restore.restoreOrCreate("ghost", makePiCodingAgent(), "/tmp/sessions"))
      .rejects.toThrow("No session or config found");
  });

  it("session 记录存在且 open 成功 → 恢复旧 session，createdNew=false", async () => {
    store.setWithFile("o1", "sid-old", "/tmp/existing.jsonl");
    const openImpl = () => makeFakeSessionManager();

    const result = await restore.restoreOrCreate("o1", makePiCodingAgent(openImpl), "/tmp/sessions");

    expect(result.createdNew).toBe(false);
  });

  it("session 文件丢失（ENOENT）→ 重建新 session，createdNew=true", async () => {
    provider.setConfig("o1", { otterType: "big" } as never);
    store.setWithFile("o1", "sid-old", "/tmp/missing.jsonl");

    const result = await restore.restoreOrCreate("o1", makePiCodingAgent(), "/tmp/sessions");

    expect(result.createdNew).toBe(true);
  });

  it("session 文件损坏（open 返回无效状态）→ 重建新 session，createdNew=true", async () => {
    provider.setConfig("o1", { otterType: "big" } as never);
    store.setWithFile("o1", "sid-old", "/tmp/corrupt.jsonl");
    const openImpl = () => ({ getSessionId: () => null, getSessionFile: () => null });

    const result = await restore.restoreOrCreate("o1", makePiCodingAgent(openImpl), "/tmp/sessions");

    expect(result.createdNew).toBe(true);
  });
});
