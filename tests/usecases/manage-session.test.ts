import { describe, it, expect, vi } from "vitest";
import { ManageSession } from "@usecases/otter/manage-session";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { AgentGateway } from "@usecases/otter/agent-gateway";
import type { ConversationQueryGateway, MemoryLayerGateway } from "@usecases/otter/manage-session";
import type { OtterSession, SessionHandoffSummary } from "@entities/otter/otter-session";
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
    handoffSummary: null,
    ...overrides,
  };
}

function mockHandoffSummary(overrides: Partial<SessionHandoffSummary> = {}): SessionHandoffSummary {
  return {
    conversationId: "conv-1",
    sessionSequence: 1,
    keyDecisions: ["使用 Clean Architecture"],
    pendingTasks: ["实现 Session 交接"],
    activeContext: "正在开发对话管理系统",
    participantStatus: { "otter-1": "active" },
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

/** 带状态追踪的 mock repo：setHandoffSummary 会实际写入 sessions map */
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
    setHandoffSummary: vi.fn(async (id: string, summary: SessionHandoffSummary) => {
      const s = sessions.get(id);
      if (s) s.handoffSummary = summary;
    }),
    restoreSessionStatus: vi.fn(async (id: string, status: string) => {
      const s = sessions.get(id);
      if (s) {
        s.status = status as OtterSession["status"];
        s.archivedAt = null;
        s.archiveReason = null;
      }
    }),
    deleteSession: vi.fn(async (id: string) => {
      sessions.delete(id);
    }),
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
    it("creates a session with handoffSummary: null (B14)", async () => {
      const repo = mockRepo();
      const session = await new ManageSession(
        repo, mockAgentGateway(), mockConversationQuery(), mockMemoryLayer(), mockLogger(),
      ).createSession("otter-1");

      expect(session.handoffSummary).toBeNull();
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

  describe("handoffSession", () => {
    it("archives current session and creates new one (B-CS-1, B-CS-2)", async () => {
      const activeSession = mockSession();
      const repo = mockRepo(activeSession);
      const agentGateway = mockAgentGateway();
      const conversationQuery = mockConversationQuery(["conv-1", "conv-2"]);
      const memoryLayer = mockMemoryLayer();

      const ms = new ManageSession(repo, agentGateway, conversationQuery, memoryLayer, mockLogger());
      const summary = mockHandoffSummary();
      const result = await ms.handoffSession("sess-1", summary, "token_threshold");

      /** 归档旧 session */
      expect(result.archivedSession.status).toBe("archived");
      expect(result.archivedSession.archivedAt).toBeTruthy();
      expect(result.archivedSession.archiveReason).toBe("token_threshold");

      /** 创建新 session */
      expect(result.newSession.status).toBe("active");
      expect(result.newSession.previousSessionId).toBe("sess-1");
      expect(result.newSession.handoffSummary).toEqual(summary);

      /** 工作记忆转历史（通过状态追踪验证） */
      expect(memoryLayer._transitions).toEqual([
        { conversationId: "conv-1", from: "working", to: "historical" },
        { conversationId: "conv-2", from: "working", to: "historical" },
      ]);

      /** Agent reset: 仅 1 次，注入交接摘要上下文（BUG-1 修复：不再双重 reset） */
      expect(agentGateway._resetCalls).toHaveLength(1);
      expect(agentGateway._resetCalls[0].otterId).toBe("otter-1");
      expect(agentGateway._resetCalls[0].context).toEqual({ context: { handoffSummary: summary } });
    });

    it("stores handoffSummary on new session via repository", async () => {
      const activeSession = mockSession();
      const repo = mockRepo(activeSession);
      const ms = new ManageSession(
        repo, mockAgentGateway(), mockConversationQuery(), mockMemoryLayer(), mockLogger(),
      );
      const summary = mockHandoffSummary();
      const result = await ms.handoffSession("sess-1", summary, "token_threshold");

      /** 通过 repo 状态验证 handoffSummary 已持久化（非引用共享副作用） */
      const storedSession = repo._sessions.get(result.newSession.id);
      expect(storedSession?.handoffSummary).toEqual(summary);
      expect(result.newSession.handoffSummary).toEqual(summary);
    });

    it("throws if session not found", async () => {
      const repo = mockRepo(); // no session
      const ms = new ManageSession(
        repo, mockAgentGateway(), mockConversationQuery(), mockMemoryLayer(), mockLogger(),
      );

      await expect(
        ms.handoffSession("nonexistent", mockHandoffSummary(), "token_threshold"),
      ).rejects.toThrow("Session not found");
    });

    it("throws if session is not active", async () => {
      const archivedSession = mockSession({ status: "archived" });
      const repo = mockRepo(archivedSession);
      const ms = new ManageSession(
        repo, mockAgentGateway(), mockConversationQuery(), mockMemoryLayer(), mockLogger(),
      );

      await expect(
        ms.handoffSession("sess-1", mockHandoffSummary(), "token_threshold"),
      ).rejects.toThrow("Session is not active");
    });

    it("rolls back archive when createSession fails", async () => {
      const activeSession = mockSession();
      const repo = mockRepo(activeSession);
      const memoryLayer = mockMemoryLayer();
      const agentGateway = mockAgentGateway();

      // Force createSession to fail: make getActiveSession always return a blocking session
      const blockingSession = mockSession({ id: "blocking-sess" });
      repo.getActiveSession = vi.fn(async () => blockingSession);

      const ms = new ManageSession(repo, agentGateway, mockConversationQuery(["conv-1"]), memoryLayer, mockLogger());

      await expect(
        ms.handoffSession("sess-1", mockHandoffSummary(), "token_threshold"),
      ).rejects.toThrow("already has an active session");

      // Session should be rolled back to "active"
      const restored = repo._sessions.get("sess-1");
      expect(restored?.status).toBe("active");

      // Memory layers should be rolled back
      expect(memoryLayer._transitions).toEqual([
        { conversationId: "conv-1", from: "working", to: "historical" },
        { conversationId: "conv-1", from: "historical", to: "working" },
      ]);

      // No agent reset should have happened
      expect(agentGateway._resetCalls).toHaveLength(0);
    });

    it("rolls back archive when setHandoffSummary fails", async () => {
      const activeSession = mockSession();
      const repo = mockRepo(activeSession);
      const memoryLayer = mockMemoryLayer();
      const agentGateway = mockAgentGateway();

      // Make setHandoffSummary throw
      repo.setHandoffSummary = vi.fn(async () => { throw new Error("DB write failed"); });

      const ms = new ManageSession(repo, agentGateway, mockConversationQuery(["conv-1"]), memoryLayer, mockLogger());

      await expect(
        ms.handoffSession("sess-1", mockHandoffSummary(), "token_threshold"),
      ).rejects.toThrow("DB write failed");

      // Session should be rolled back
      const restored = repo._sessions.get("sess-1");
      expect(restored?.status).toBe("active");

      // Zombie new session should be cleaned up (BUG-3)
      expect(repo._sessions.size).toBe(1);
      expect(repo._sessions.has("sess-1")).toBe(true);

      // Memory layers should be rolled back
      expect(memoryLayer._transitions).toEqual([
        { conversationId: "conv-1", from: "working", to: "historical" },
        { conversationId: "conv-1", from: "historical", to: "working" },
      ]);

      // No agent reset
      expect(agentGateway._resetCalls).toHaveLength(0);
    });

  });
});
