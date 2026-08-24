/**
 * ManageSession.restartSession 单元测试（F20260810rstart）。
 * 真 sqlite + 真 ManageSession，仅 seam 掉 AgentGateway 和记忆/对话网关。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { ManageSession } from "@usecases/otter/manage-session";
import type { ConversationQueryGateway, MemoryLayerGateway } from "@usecases/otter/manage-session";
import type { AgentGateway } from "@usecases/otter/agent-gateway";
import { buildNewSession } from "@entities/otter/otter-session";
import { createTestLogger } from "../../helpers/logger";

function fakeAgentGateway() {
  const calls: Array<{ method: string; otterId: string }> = [];
  return {
    _calls: calls,
    create: vi.fn(async (otterId: string) => { calls.push({ method: "create", otterId }); }),
    reset: vi.fn(async (otterId: string) => { calls.push({ method: "reset", otterId }); }),
    destroy: vi.fn(async (otterId: string) => { calls.push({ method: "destroy", otterId }); }),
  } as unknown as AgentGateway & { _calls: Array<{ method: string; otterId: string }> };
}

describe("ManageSession.restartSession（F20260810rstart）", () => {
  let db: Database.Database;
  let repo: SqliteOtterRepository;
  let gateway: ReturnType<typeof fakeAgentGateway>;
  let memoryTransitions: Array<{ from: string; to: string }>;
  let manageSession: ManageSession;

  const OTTER_ID = "test-otter";

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    repo = new SqliteOtterRepository(db);
    gateway = fakeAgentGateway();

    memoryTransitions = [];
    const conversationQuery: ConversationQueryGateway = {
      getIdsByOtterId: vi.fn(async () => ["conv-1"]),
    };
    const memoryLayer: MemoryLayerGateway = {
      updateLayer: vi.fn(async (_id: string, from: string, to: string) => {
        memoryTransitions.push({ from, to });
      }),
    };

    manageSession = new ManageSession(repo, gateway, conversationQuery, memoryLayer, createTestLogger());

    // 种子 otter + 首世 session
    db.prepare(`INSERT INTO otters (id, name, type, status, created_at) VALUES (?, '测试獭', 'big', 'active', datetime('now'))`).run(OTTER_ID);
    const firstSession = buildNewSession(OTTER_ID, null, null);
    repo.createSession(firstSession);
  });

  afterEach(() => {
    db.close();
  });

  it("正常重启：归档旧 session + 创建新 session + summary 双写", async () => {
    const oldSession = (await repo.getActiveSession(OTTER_ID))!;

    const result = await manageSession.restartSession(OTTER_ID, "前情摘要");

    // 旧 session 归档
    const history = await repo.getSessionHistory(OTTER_ID);
    expect(history).toHaveLength(2);
    const archived = history.find((s) => s.id === oldSession.id)!;
    expect(archived.status).toBe("restarted");
    expect(archived.archiveReason).toBe("restart");
    expect(archived.summary).toBe("前情摘要");

    // 新 session 创建
    const newSession = history.find((s) => s.id !== oldSession.id)!;
    expect(newSession.status).toBe("active");
    expect(newSession.previousSessionId).toBe(oldSession.id);
    expect(newSession.summary).toBe("前情摘要");

    // 返回新 session
    expect(result.id).toBe(newSession.id);

    // agent reset + 记忆转历史
    expect(gateway._calls.filter((c) => c.method === "reset")).toHaveLength(1);
    expect(memoryTransitions).toEqual([{ from: "working", to: "historical" }]);
  });

  it("无 active session 时直接创建新 session（不报错）", async () => {
    // 归档现有 session
    const active = (await repo.getActiveSession(OTTER_ID))!;
    await manageSession.archiveSession(active.id, { reason: "dissolve", isNegativeCase: false });

    const result = await manageSession.restartSession(OTTER_ID, "从零开始");

    expect(result.status).toBe("active");
    expect(result.summary).toBe("从零开始");
    // 不应调用 archive（因为没有 active session）
    expect(gateway._calls.filter((c) => c.method === "reset")).toHaveLength(1); // 只有 createSession 后的 reset 不会触发，但 archive 的 reset 已在上面触发
  });

  it("summary 为空时不写入前情摘要", async () => {
    const result = await manageSession.restartSession(OTTER_ID);

    expect(result.summary).toBeNull();
    const history = await repo.getSessionHistory(OTTER_ID);
    const newSession = history.find((s) => s.status === "active")!;
    expect(newSession.summary).toBeNull();
  });

  it("竞态认领：createSession 撞 conflict 时认领既有新行并补写 summary", async () => {
    const oldSession = (await repo.getActiveSession(OTTER_ID))!;

    // 模拟竞态：archive 的 reset 钩子抢先建新行
    gateway.reset = vi.fn(async () => {
      await repo.createSession({
        id: "backfilled-by-invoke",
        otterId: OTTER_ID,
        status: "active",
        previousSessionId: oldSession.id,
        startedAt: new Date().toISOString(),
        archivedAt: null,
        archiveReason: null,
        isNegativeCase: false,
        summary: null,
      });
    });

    const result = await manageSession.restartSession(OTTER_ID, "竞态前情");

    expect(result.id).toBe("backfilled-by-invoke");
    expect(result.summary).toBe("竞态前情");
  });
});

describe("ManageSession - F20260821scrt summary 脱敏", () => {
  it("setSessionSummary 写入脱敏后内容", async () => {
    const written: { sessionId: string; summary: string }[] = [];
    const repo = {
      setSessionSummary: async (sessionId: string, summary: string) => {
        written.push({ sessionId, summary });
      },
    } as unknown as import("@frameworks/db/otter/sqlite-otter-repository").SqliteOtterRepository;
    const gateway = fakeAgentGateway();
    const manageSession = new ManageSession(
      repo, gateway,
      { getIdsByOtterId: vi.fn(async () => []) } as unknown as ConversationQueryGateway,
      { updateLayer: vi.fn(async () => {}) } as unknown as MemoryLayerGateway,
      createTestLogger(),
    );

    await manageSession.setSessionSummary("session-1", "上轮贴过密钥 api_key: 0123456789abcdef01234567");

    expect(written).toHaveLength(1);
    expect(written[0].sessionId).toBe("session-1");
    expect(written[0].summary).toContain("[REDACTED]");
    expect(written[0].summary).not.toContain("0123456789abcdef");
  });
});

describe("ManageSession - 二轮审视#4 archive 路径脱敏", () => {
  it("archiveSession 写入旧行的 summary 脱敏", async () => {
    const archived: { sessionId: string; params: { summary?: string | null } }[] = [];
    const repo = {
      getActiveSession: vi.fn(async () => null),
      getSessionHistory: vi.fn(async () => []),
      getSessionById: vi.fn(async () => ({
        id: "session-1",
        otterId: "otter-1",
        status: "active",
      })),
      archiveSession: async (sessionId: string, _status: string, params: { summary?: string | null }) => {
        archived.push({ sessionId, params });
        return {};
      },
    } as unknown as import("@frameworks/db/otter/sqlite-otter-repository").SqliteOtterRepository;
    const gateway = fakeAgentGateway();
    const manageSession = new ManageSession(
      repo, gateway,
      { getIdsByOtterId: vi.fn(async () => []) } as unknown as ConversationQueryGateway,
      { updateLayer: vi.fn(async () => {}) } as unknown as MemoryLayerGateway,
      createTestLogger(),
    );

    const result = await manageSession.archiveSession("session-1", {
      reason: "restart",
      isNegativeCase: false,
      summary: "前情里有密钥 密钥：a1b2c3d4e5f6a7b8c9d0e1f2",
    });

    expect(archived).toHaveLength(1);
    expect(String(archived[0].params.summary)).not.toContain("a1b2c3d4e5f6");
    expect(String(archived[0].params.summary)).toContain("[REDACTED]");
    expect(String(result.summary)).toContain("[REDACTED]");
  });
});
