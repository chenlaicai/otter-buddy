import { describe, it, expect, vi } from "vitest";
import { ManageSession } from "@usecases/otter/manage-session";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { AgentGateway } from "@usecases/otter/agent-gateway";
import type { ConversationQueryGateway, MemoryLayerGateway } from "@usecases/otter/manage-session";
import type { OtterSession } from "@entities/otter/otter-session";
import type { Logger } from "@usecases/ports/logger";

function mockSession(overrides: Partial<OtterSession> = {}): OtterSession {
  return {
    id: "sess-1",
    otterId: "otter-1",
    status: "active",
    previousSessionId: null,
    startedAt: "2026-07-16T00:00:00Z",
    archivedAt: null,
    archiveReason: null,
    isNegativeCase: false,
    summary: null,
    ...overrides,
  };
}

/** 创建 noop Logger mock */
function mockLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => mockLogger(),
  };
}

/** 带状态追踪的 mock repo：archive 会实际改写 sessions map */
function mockRepo(session: OtterSession | null = null): OtterRepository & { _sessions: Map<string, OtterSession> } {
  const sessions = new Map<string, OtterSession>();
  if (session) sessions.set(session.id, session);

  return {
    _sessions: sessions,
    createOtter: vi.fn(),
    getById: vi.fn(),
    getBigOtter: vi.fn(),
    dissolve: vi.fn(),
    deleteOtter: vi.fn(),
    createSession: vi.fn(async (s: OtterSession) => { sessions.set(s.id, s); }),
    getActiveSession: vi.fn(async () => session?.status === "active" ? session : null),
    archiveSession: vi.fn(async (id: string, status: string, params: { reason: string; isNegativeCase: boolean; summary?: string }) => {
      const s = sessions.get(id);
      if (s) {
        s.status = status as OtterSession["status"];
        s.archivedAt = new Date().toISOString();
        s.archiveReason = params.reason;
        s.isNegativeCase = params.isNegativeCase;
        s.summary = params.summary ?? null;
      }
    }),
    getSessionHistory: vi.fn(async () => session ? [session] : []),
    getSessionById: vi.fn(async (id: string) => sessions.get(id) ?? null),
  } as unknown as OtterRepository & { _sessions: Map<string, OtterSession> };
}

function mockAgentGateway(): AgentGateway & { _resetCalls: Array<{ otterId: string; context?: unknown }> } {
  const resetCalls: Array<{ otterId: string; context?: unknown }> = [];
  return {
    _resetCalls: resetCalls,
    create: vi.fn(),
    destroy: vi.fn(),
    reset: vi.fn(async (otterId: string, context?: unknown) => {
      resetCalls.push({ otterId, context });
    }),
  };
}

function mockConversationQuery(conversationIds: string[] = ["conv-1"]): ConversationQueryGateway {
  return {
    getIdsByOtterId: vi.fn(async () => conversationIds),
  };
}

function mockMemoryLayer(): MemoryLayerGateway & { _transitions: Array<{ conversationId: string; from: string; to: string }> } {
  const transitions: Array<{ conversationId: string; from: string; to: string }> = [];
  return {
    _transitions: transitions,
    updateLayer: vi.fn(async (conversationId: string, from: string, to: string) => {
      transitions.push({ conversationId, from, to });
    }),
  };
}

describe("ManageSession", () => {
  describe("createSession", () => {
    it("creates an active session with null summary (B14)", async () => {
      const repo = mockRepo();
      const session = await new ManageSession(
        repo, mockAgentGateway(), mockConversationQuery(), mockMemoryLayer(), mockLogger(),
      ).createSession("otter-1");

      expect(session.summary).toBeNull();
      expect(session.status).toBe("active");
      expect(session.previousSessionId).toBeNull();
    });

    it("chains to previous session (B14)", async () => {
      const prevSession = mockSession({ id: "prev-sess", status: "archived" });
      const repo = mockRepo(prevSession);
      const session = await new ManageSession(
        repo, mockAgentGateway(), mockConversationQuery(), mockMemoryLayer(), mockLogger(),
      ).createSession("otter-1");

      expect(session.previousSessionId).toBe("prev-sess");
    });

    it("throws if active session exists", async () => {
      const activeSession = mockSession();
      const repo = mockRepo(activeSession);
      const ms = new ManageSession(
        repo, mockAgentGateway(), mockConversationQuery(), mockMemoryLayer(), mockLogger(),
      );

      await expect(ms.createSession("otter-1")).rejects.toThrow("already has an active session");
    });
  });

  /**
   * F20260805rsto：重启全链路回归守护。
   * 生产事故：archive 被控制器跳过导致 reset 永不执行（重启空操作）。
   * 此处锁定 archiveSession 的完整副作用，保证链路的后半段不再退化。
   */
  describe("restart 链路（archiveSession + createSession）", () => {
    it("archiveSession 封存旧行 + 记忆 working→historical + agentGateway.reset", async () => {
      const repo = mockRepo(mockSession());
      const gateway = mockAgentGateway();
      const memory = mockMemoryLayer();
      const ms = new ManageSession(repo, gateway, mockConversationQuery(["conv-1"]), memory, mockLogger());

      await ms.archiveSession("sess-1", { reason: "restart", isNegativeCase: false, summary: "前情" });

      const old = repo._sessions.get("sess-1")!;
      expect(old.status).toBe("restarted");
      expect(old.archiveReason).toBe("restart");
      expect(old.summary).toBe("前情");
      expect(memory._transitions).toEqual([{ conversationId: "conv-1", from: "working", to: "historical" }]);
      expect(gateway._resetCalls).toEqual([{ otterId: "otter-1", context: undefined }]);
    });

    it("createSession 携带 summary 写入新行（前情摘要注入新獭生）", async () => {
      const repo = mockRepo();
      const ms = new ManageSession(
        repo, mockAgentGateway(), mockConversationQuery(), mockMemoryLayer(), mockLogger(),
      );

      const session = await ms.createSession("otter-1", { summary: "前情" });

      expect(session.summary).toBe("前情");
      expect(repo._sessions.get(session.id)!.summary).toBe("前情");
    });

    it("restart 两步走完：旧行 restarted、新行 previousSessionId 指向旧行", async () => {
      const repo = mockRepo(mockSession());
      const gateway = mockAgentGateway();
      const ms = new ManageSession(repo, gateway, mockConversationQuery(), mockMemoryLayer(), mockLogger());

      await ms.archiveSession("sess-1", { reason: "restart", isNegativeCase: false });
      // archive 后 getActiveSession 返回 null（mock repo 的 getActiveSession 只在 active 时返回）
      const next = await ms.createSession("otter-1");

      expect(next.previousSessionId).toBe("sess-1");
      expect(gateway._resetCalls).toHaveLength(1);
    });
  });
});
