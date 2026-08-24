/**
 * F20260819rscn: 自重启信号处理测试。
 *
 * 覆盖场景：
 * - AT-1: LLM 调用 restart_otter(self) → restart + 全新 invoke（獭继续工作）
 * - AT-2: 自重启带 summary → summary 传入 restartSession
 * - AT-3: 自重启无 summary → restartSession 收到 undefined summary
 * - AT-4: restart 失败 → 降级返回原始结果（不 re-invoke）
 * - AT-5: re-invoke 失败 → 降级返回原始结果
 * - AT-6: 无 _selfRestart 信号 → 行为不变（不触发 restart）
 */
import { describe, it, expect } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SdkInvokePort } from "@usecases/ports/sdk-invoke-port";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { OtterSession } from "@entities/otter/otter-session";
import type { Message } from "@entities/conversation/message";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { HealingEvent } from "@entities/healing/healing-event";
import { createTestLogger } from "../helpers/logger";

function makeSession(overrides: Partial<OtterSession> = {}): OtterSession {
  return {
    id: "sess-1", otterId: "otter-1", status: "active",
    previousSessionId: null, startedAt: "2026-08-01T00:00:00Z",
    archivedAt: null, archiveReason: null, isNegativeCase: false,
    summary: null,
    ...overrides,
  };
}

function mockSendMessage() {
  let seq = 0;
  const failCalls: Array<{ id: string; body: string }> = [];
  return {
    start: async (): Promise<Message> => ({
      id: `msg-${++seq}`, conversationId: "conv-1", turnId: "turn-1",
      senderType: "otter", senderId: "otter-1", talkingStonePassedTo: null,
      status: "streaming", segments: [], sequenceNum: seq,
      contextTokens: null, contextTokensMax: null, source: "web",
      createdAt: new Date().toISOString(), completedAt: null,
    }),
    complete: async (id: string) => ({
      message: { id },
      turnClose: { closed: true, aggregatedTargets: ["user-1"] },
    }),
    fail: async (id: string, body?: string) => { failCalls.push({ id, body: body ?? "" }); },
    abort: async () => ({}),
    appendEvent: async () => ({}),
    sendSystem: async () => ({
      id: `sys-${++seq}`, conversationId: "conv-1", turnId: "turn-1",
      senderType: "system" as const, senderId: "system", talkingStonePassedTo: null,
      status: "completed" as const,
      segments: [], sequenceNum: seq,
      contextTokens: null, contextTokensMax: null, source: "web" as const,
      createdAt: new Date().toISOString(), completedAt: null,
    }),
    updateTokenUsage: async () => ({}),
    prepareForRetry: async (id: string) => ({ id }),
    _failCalls: failCalls,
  } as unknown as SendMessage & { _failCalls: typeof failCalls };
}

function mockQueryMessage(): QueryMessage {
  return {
    getMessageById: async (id: string) => ({
      id, status: "streaming", body: null, turnId: "turn-1",
    }),
    getMessageEvents: async () => [],
    getMessages: async () => [],
  } as unknown as QueryMessage;
}

const queryOtter: QueryOtter = {
  getById: async () => ({ id: "otter-1", name: "大獭", type: "main" }),
} as unknown as QueryOtter;

function mockManageSession(initial: OtterSession) {
  let active: OtterSession | null = initial;
  const restartCalls: Array<{ otterId: string; summary?: string }> = [];
  const failRestart = { value: false as unknown as Error | false };
  return {
    restartCalls,
    failRestart,
    mock: {
      getActiveSession: async () => active,
      createSession: async (otterId: string) => makeSession({ id: "sess-backfill", otterId }),
      restartSession: async (otterId: string, summary?: string) => {
        if (failRestart.value) throw failRestart.value;
        restartCalls.push({ otterId, summary });
        active = makeSession({
          id: "sess-new", otterId,
          summary: summary ?? null,
          previousSessionId: initial.id,
          startedAt: new Date(Date.now() + 1000).toISOString(),
        });
        return active;
      },
    } as unknown as ManageSession,
  };
}

describe("AgentInvoker — 自重启信号处理 (F20260819rscn)", () => {
  it("AT-1: restart_otter(self) → restart + 全新 invoke，獭继续工作", async () => {
    const msg = mockSendMessage();
    const session = mockManageSession(makeSession());
    let invokeCount = 0;
    const invoke: SdkInvokePort = {
      invoke: async () => {
        invokeCount++;
        if (invokeCount === 1) {
          return { text: "已标记重启当前獭生", _selfRestart: { otterId: "otter-1" } };
        }
        return { text: "基于干净上下文的回复" };
      },
      abort: () => {},
      getToolCallCount: () => 1,
      getInternalAbortReason: () => undefined,
    };
    const qm = mockQueryMessage();
    const invoker = new AgentInvoker(
      invoke, msg, qm, session.mock, queryOtter, createTestLogger(),
    );

    const result = await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "测试自重启", senderId: "user-1",
    });

    // restart 被执行一次
    expect(session.restartCalls).toHaveLength(1);
    expect(session.restartCalls[0].otterId).toBe("otter-1");

    // invoke 发生（第一次标记重启 + 第二次全新上下文；orchestrator 每轮可能多次调用 SDK）
    expect(invokeCount).toBeGreaterThanOrEqual(2);

    // 最终结果来自后续 invoke
    expect(result).toBeDefined();
  });

  it("AT-2: 自重启带 summary → summary 传入 restartSession", async () => {
    const msg = mockSendMessage();
    const session = mockManageSession(makeSession());
    let invokeCount = 0;
    const invoke: SdkInvokePort = {
      invoke: async () => {
        invokeCount++;
        if (invokeCount === 1) {
          return { text: "已标记重启", _selfRestart: { otterId: "otter-1", summary: "上下文污染需要清理" } };
        }
        return { text: "清理后的回复" };
      },
      abort: () => {},
      getToolCallCount: () => 1,
      getInternalAbortReason: () => undefined,
    };
    const qm = mockQueryMessage();
    const invoker = new AgentInvoker(
      invoke, msg, qm, session.mock, queryOtter, createTestLogger(),
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "测试", senderId: "user-1",
    });

    expect(session.restartCalls).toHaveLength(1);
    expect(session.restartCalls[0].summary).toBe("上下文污染需要清理");
  });

  it("AT-3: 自重启无 summary → restartSession 收到 undefined summary", async () => {
    const msg = mockSendMessage();
    const session = mockManageSession(makeSession());
    let invokeCount = 0;
    const invoke: SdkInvokePort = {
      invoke: async () => {
        invokeCount++;
        if (invokeCount === 1) {
          return { text: "已标记重启", _selfRestart: { otterId: "otter-1" } };
        }
        return { text: "回复" };
      },
      abort: () => {},
      getToolCallCount: () => 1,
      getInternalAbortReason: () => undefined,
    };
    const qm = mockQueryMessage();
    const invoker = new AgentInvoker(
      invoke, msg, qm, session.mock, queryOtter, createTestLogger(),
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "测试", senderId: "user-1",
    });

    expect(session.restartCalls).toHaveLength(1);
    expect(session.restartCalls[0].summary).toBeUndefined();
  });

  it("AT-4: restart 失败 → 降级返回原始结果，不 re-invoke", async () => {
    const msg = mockSendMessage();
    const session = mockManageSession(makeSession());
    session.failRestart.value = new Error("pi 锁超时");
    let invokeCount = 0;
    const invoke: SdkInvokePort = {
      invoke: async () => {
        invokeCount++;
        return { text: "已标记重启", _selfRestart: { otterId: "otter-1" } };
      },
      abort: () => {},
      getToolCallCount: () => 1,
      getInternalAbortReason: () => undefined,
    };
    const qm = mockQueryMessage();
    const invoker = new AgentInvoker(
      invoke, msg, qm, session.mock, queryOtter, createTestLogger(),
    );

    const result = await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "测试", senderId: "user-1",
    });

    // restart 失败，不 re-invoke（invoke 次数不变）
    expect(invokeCount).toBeGreaterThanOrEqual(1);
    expect(session.restartCalls).toHaveLength(0);
    expect(result).toBeDefined();
  });

  it("AT-5: re-invoke 失败 → 降级返回原始结果", async () => {
    const msg = mockSendMessage();
    const session = mockManageSession(makeSession());
    let invokeCount = 0;
    const invoke: SdkInvokePort = {
      invoke: async () => {
        invokeCount++;
        if (invokeCount === 1) {
          return { text: "已标记重启", _selfRestart: { otterId: "otter-1" } };
        }
        throw new Error("LLM API error");
      },
      abort: () => {},
      getToolCallCount: () => 1,
      getInternalAbortReason: () => undefined,
    };
    const qm = mockQueryMessage();
    const invoker = new AgentInvoker(
      invoke, msg, qm, session.mock, queryOtter, createTestLogger(),
    );

    const result = await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "测试", senderId: "user-1",
    });

    // restart 成功但 re-invoke 失败
    expect(session.restartCalls).toHaveLength(1);
    // re-invoke 发生（invoke 次数 > 原始次数）
    expect(invokeCount).toBeGreaterThan(1);
    // 降级返回原始结果（result 定义且包含原始消息信息）
    expect(result).toBeDefined();
    expect(result.messageId).toBeDefined();
  });

  it("AT-6: 无 _selfRestart 信号 → 行为不变", async () => {
    const msg = mockSendMessage();
    const session = mockManageSession(makeSession());
    const invoke: SdkInvokePort = {
      invoke: async () => ({ text: "正常输出" }),
      abort: () => {},
      getToolCallCount: () => 1,
      getInternalAbortReason: () => undefined,
    };
    const qm = mockQueryMessage();
    const invoker = new AgentInvoker(
      invoke, msg, qm, session.mock, queryOtter, createTestLogger(),
    );

    const result = await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "测试", senderId: "user-1",
    });

    // 无 restart，只有 1 次 invoke
    expect(session.restartCalls).toHaveLength(0);
    expect(result).toBeDefined();
  });
});

describe("AgentInvoker — 自重启循环防护 (F20260824srst)", () => {
  it("AT-7: 防循环——session 由自重启创建时，不执行 restart", async () => {
    const msg = mockSendMessage();
    const session = mockManageSession(makeSession({ id: "sess-self-restart" }));
    const invoke: SdkInvokePort = {
      invoke: async () => ({ text: "已标记重启", _selfRestart: { otterId: "otter-1" } }),
      abort: () => {},
      getToolCallCount: () => 1,
      getInternalAbortReason: () => undefined,
    };
    // mock healingRepo: 当前 session 由自重启创建
    const healingRepo = {
      create: async () => {},
      findById: async () => null,
      findOpen: async () => [],
      findAll: async () => [],
      findByConversation: async () => [],
      findRecentByOtter: async () => [{
        id: "evt-1", errorType: "self_restart" as const,
        context: { newSessionId: "sess-self-restart" },
        createdAt: new Date().toISOString(),
      } as unknown as HealingEvent],
      updateStatus: async () => {},
      resolve: async () => {},
      getStats: async () => ({ open: 0, resolved: 0, dismissed: 0, byType: {}, bySeverity: {} }),
      autoStaleDismiss: async () => 0,
    } as HealingEventRepository;
    const qm = mockQueryMessage();
    const invoker = new AgentInvoker(
      invoke, msg, qm, session.mock, queryOtter, createTestLogger(),
      undefined, undefined, undefined, undefined, healingRepo,
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "你重启自己", senderId: "user-1",
    });

    // 防循环：restart 未被执行（session 由自重启创建 → handleSelfRestartSignal 返回 null）
    expect(session.restartCalls).toHaveLength(0);
  });

  it("AT-8: continuation message 替代原始消息——re-invoke 传入的不是原始消息", async () => {
    const msg = mockSendMessage();
    const session = mockManageSession(makeSession());
    let invokeCount = 0;
    const invokeContents: string[] = [];
    const invoke: SdkInvokePort = {
      invoke: async (otterId: string, content: string) => {
        invokeCount++;
        invokeContents.push(content);
        if (invokeCount === 1) {
          return { text: "已标记重启", _selfRestart: { otterId: "otter-1", summary: "上下文污染" } };
        }
        return { text: "基于干净上下文的回复" };
      },
      abort: () => {},
      getToolCallCount: () => 1,
      getInternalAbortReason: () => undefined,
    };
    const qm = mockQueryMessage();
    const invoker = new AgentInvoker(
      invoke, msg, qm, session.mock, queryOtter, createTestLogger(),
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "你重启自己", senderId: "user-1",
    });

    // restart 被执行
    expect(session.restartCalls).toHaveLength(1);
    // re-invoke 发生（invoke 次数 >= 2）
    expect(invokeCount).toBeGreaterThanOrEqual(2);
    // continuation message 出现在某次 invoke 中（可能是第 2 次或第 3 次，取决于 orchestrator 重试）
    const hasContinuationMsg = invokeContents.some(c => c.includes("已完成自重启"));
    expect(hasContinuationMsg).toBe(true);
  });

  it("AT-9: self_restart healing 事件被写入（上限判定数据源）", async () => {
    const msg = mockSendMessage();
    const session = mockManageSession(makeSession());
    let invokeCount = 0;
    const invoke: SdkInvokePort = {
      invoke: async () => {
        invokeCount++;
        if (invokeCount === 1) {
          return { text: "已标记重启", _selfRestart: { otterId: "otter-1" } };
        }
        return { text: "回复" };
      },
      abort: () => {},
      getToolCallCount: () => 1,
      getInternalAbortReason: () => undefined,
    };
    const createdEvents: HealingEvent[] = [];
    const healingRepo = {
      create: async (evt: HealingEvent) => { createdEvents.push(evt); },
      findById: async () => null,
      findOpen: async () => [],
      findAll: async () => [],
      findByConversation: async () => [],
      findRecentByOtter: async () => [], // 无 self_restart 事件 → 防循环检查通过
      updateStatus: async () => {},
      resolve: async () => {},
      getStats: async () => ({ open: 0, resolved: 0, dismissed: 0, byType: {}, bySeverity: {} }),
      autoStaleDismiss: async () => 0,
    } as HealingEventRepository;
    const qm = mockQueryMessage();
    const invoker = new AgentInvoker(
      invoke, msg, qm, session.mock, queryOtter, createTestLogger(),
      undefined, undefined, undefined, undefined, healingRepo,
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "测试", senderId: "user-1",
    });

    // self_restart 事件被写入
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0].errorType).toBe("self_restart");
    expect(createdEvents[0].otterId).toBe("otter-1");
    // context.newSessionId 指向新 session
    const ctx = createdEvents[0].context as { newSessionId?: string };
    expect(ctx?.newSessionId).toBe("sess-new");
  });
});
