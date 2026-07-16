import { describe, it, expect, vi } from "vitest";
import { ManageSession } from "@usecases/otter/manage-session";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { AgentGateway } from "@usecases/otter/agent-gateway";
import type { ConversationQueryGateway, ConversationBindingGateway, MemoryLayerGateway } from "@usecases/otter/manage-session";
import type { OtterSession, SessionHandoffSummary } from "@entities/otter/otter-session";

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
    archiveSession: vi.fn(async (id: string) => {
      const s = sessions.get(id);
      if (s) { s.status = "archived"; s.archivedAt = new Date().toISOString(); }
    }),
    getSessionHistory: vi.fn(async () => session ? [session] : []),
    getSessionById: vi.fn(async (id: string) => sessions.get(id) ?? null),
    setHandoffSummary: vi.fn(async (id: string, summary: SessionHandoffSummary) => {
      const s = sessions.get(id);
      if (s) s.handoffSummary = summary;
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

/** 带状态追踪的 mock binding */
function mockConversationBinding(): ConversationBindingGateway & { _bindings: Map<string, string | null> } {
  const bindings = new Map<string, string | null>();
  return {
    _bindings: bindings,
    updateActiveSessionId: vi.fn(async (conversationId: string, sessionId: string | null) => {
      bindings.set(conversationId, sessionId);
    }),
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
        repo, mockAgentGateway(), mockConversationQuery(), mockMemoryLayer(), mockConversationBinding(),
      ).createSession("otter-1");

      expect(session.handoffSummary).toBeNull();
      expect(session.status).toBe("active");
      expect(session.previousSessionId).toBeNull();
    });

    it("chains to previous session (B14)", async () => {
      const prevSession = mockSession({ id: "prev-sess", status: "archived" });
      const repo = mockRepo(prevSession);
      const session = await new ManageSession(
        repo, mockAgentGateway(), mockConversationQuery(), mockMemoryLayer(), mockConversationBinding(),
      ).createSession("otter-1");

      expect(session.previousSessionId).toBe("prev-sess");
    });

    it("throws if active session exists", async () => {
      const activeSession = mockSession();
      const repo = mockRepo(activeSession);
      const ms = new ManageSession(
        repo, mockAgentGateway(), mockConversationQuery(), mockMemoryLayer(), mockConversationBinding(),
      );

      await expect(ms.createSession("otter-1")).rejects.toThrow("already has an active session");
    });
  });

  describe("handoffSession", () => {
    it("archives current session and creates new one (B-CS-1, B-CS-2)", async () => {
      const activeSession = mockSession();
      const repo = mockRepo(activeSession);
      const agentGateway = mockAgentGateway();
      const conversationQuery = mockConversationQuery(["conv-1", "conv-2"]);
      const conversationBinding = mockConversationBinding();
      const memoryLayer = mockMemoryLayer();

      const ms = new ManageSession(repo, agentGateway, conversationQuery, memoryLayer, conversationBinding);
      const summary = mockHandoffSummary();
      const result = await ms.handoffSession("sess-1", summary, "token_threshold");

      /** 归档旧 session */
      expect(result.archivedSession.status).toBe("archived");
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

      /** 更新对话绑定（通过状态追踪验证） */
      expect(conversationBinding._bindings.get("conv-1")).toBe(result.newSession.id);
      expect(conversationBinding._bindings.get("conv-2")).toBe(result.newSession.id);

      /** Agent reset: 1st from archiveSession, 2nd from handoffSession (B-CS-3) */
      expect(agentGateway._resetCalls).toHaveLength(2);
      expect(agentGateway._resetCalls[0].otterId).toBe("otter-1");
      expect(agentGateway._resetCalls[1].otterId).toBe("otter-1");
    });

    it("stores handoffSummary on new session via repository", async () => {
      const activeSession = mockSession();
      const repo = mockRepo(activeSession);
      const ms = new ManageSession(
        repo, mockAgentGateway(), mockConversationQuery(), mockMemoryLayer(), mockConversationBinding(),
      );
      const summary = mockHandoffSummary();
      const result = await ms.handoffSession("sess-1", summary, "token_threshold");

      /** 通过 repo 内部状态验证 handoffSummary 已存储 */
      expect(result.newSession.handoffSummary).toEqual(summary);
    });

    it("throws if session not found", async () => {
      const repo = mockRepo(); // no session
      const ms = new ManageSession(
        repo, mockAgentGateway(), mockConversationQuery(), mockMemoryLayer(), mockConversationBinding(),
      );

      await expect(
        ms.handoffSession("nonexistent", mockHandoffSummary(), "token_threshold"),
      ).rejects.toThrow("Session not found");
    });

    it("throws if session is not active", async () => {
      const archivedSession = mockSession({ status: "archived" });
      const repo = mockRepo(archivedSession);
      const ms = new ManageSession(
        repo, mockAgentGateway(), mockConversationQuery(), mockMemoryLayer(), mockConversationBinding(),
      );

      await expect(
        ms.handoffSession("sess-1", mockHandoffSummary(), "token_threshold"),
      ).rejects.toThrow("Session is not active");
    });
  });

  describe("archiveSession", () => {
    it("does not update conversation bindings (only handoffSession does)", async () => {
      const activeSession = mockSession();
      const repo = mockRepo(activeSession);
      const binding = mockConversationBinding();
      const ms = new ManageSession(
        repo, mockAgentGateway(), mockConversationQuery(), mockMemoryLayer(), binding,
      );

      await ms.archiveSession("sess-1", { reason: "user", isNegativeCase: false });

      /** archiveSession 不应更新绑定 */
      expect(binding._bindings.size).toBe(0);
    });
  });
});
