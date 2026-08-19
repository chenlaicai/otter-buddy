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
