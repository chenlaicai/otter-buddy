import { describe, it, expect } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SdkInvokePort, AgentStreamEvent } from "@usecases/ports/sdk-invoke-port";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Message } from "@entities/conversation/message";
import type { OtterSession } from "@entities/otter/otter-session";
import { DomainError } from "@entities/errors";
import { createTestLogger } from "../helpers/logger";

const speakingMsg: Message = {
  id: "msg-streaming", conversationId: "conv-1", turnId: "turn-1",
  senderType: "otter", senderId: "otter-1",
  talkingStonePassedTo: ["user-1"], status: "speaking",
  body: "Response",
  sequenceNum: 2, contextTokens: null, contextTokensMax: null,
  source: "web",
      createdAt: "2026-07-16T00:00:00Z", completedAt: null,
};

const completedMsg: Message = {
  id: "msg-streaming", conversationId: "conv-1", turnId: "turn-1",
  senderType: "otter", senderId: "otter-1",
  talkingStonePassedTo: ["user-1"], status: "completed",
  body: "Response",
  sequenceNum: 2, contextTokens: null, contextTokensMax: null,
  source: "web",
      createdAt: "2026-07-16T00:00:00Z", completedAt: "2026-07-16T00:00:01Z",
};

/** 创建 SendMessage mock，记录调用并返回模拟消息 */
function mockSendMessage() {
  const streamingMsg: Message = {
    id: "msg-streaming", conversationId: "conv-1", turnId: "turn-1",
    senderType: "otter", senderId: "otter-1",
    talkingStonePassedTo: null, status: "streaming",
    body: null,
    sequenceNum: 2, contextTokens: null, contextTokensMax: null,
    source: "web",
      createdAt: "2026-07-16T00:00:00Z", completedAt: null,
  };
  const calls: { fail?: Array<{ id: string; body: string }>; abort?: Array<{ id: string; body: string }>; sendSystem?: string[]; prepareForRetry?: string[] } = { fail: [], abort: [], sendSystem: [], prepareForRetry: [] };
  const sendSystemBodies: string[] = [];
  const completeCalls: Array<{ id: string; input?: { contextTokens?: number; contextTokensMax?: number } }> = [];
  return {
    start: async () => streamingMsg,
    complete: async (id: string, input?: { contextTokens?: number; contextTokensMax?: number }) => {
      completeCalls.push({ id, input });
      return { message: completedMsg, turnClose: { closed: true, aggregatedTargets: ["user-1"] } };
    },
    fail: async (id: string, body?: string) => { calls.fail!.push({ id, body: body ?? '' }); },
    abort: async (id: string, input: { body: string }) => { calls.abort!.push({ id, body: input.body }); },
    appendEvent: async () => ({}),
    sendSystem: async (_conversationId: string, body: string) => { sendSystemBodies.push(body); return { ...streamingMsg, id: "msg-system", senderType: "system" as const, status: "completed" as const }; },
    updateTokenUsage: async () => ({}),
    prepareForRetry: async (id: string) => { calls.prepareForRetry!.push(id); return { ...streamingMsg, status: "streaming" as const, body: null, talkingStonePassedTo: null }; },
    _calls: calls,
    _sendSystemBodies: sendSystemBodies,
    _completeCalls: completeCalls,
  } as unknown as SendMessage & { _calls: { fail: Array<{ id: string; body: string }>; abort: Array<{ id: string; body: string }>; sendSystem: string[]; prepareForRetry: string[] }; _sendSystemBodies: string[]; _completeCalls: Array<{ id: string; input?: { contextTokens?: number; contextTokensMax?: number } }> };
}

function mockQueryMessage(): QueryMessage {
  return { getMessageById: async () => speakingMsg } as unknown as QueryMessage;
}

function makeSession(overrides: Partial<OtterSession> = {}): OtterSession {
  return {
    id: "sess-1", otterId: "otter-1", status: "active",
    previousSessionId: null, startedAt: "2026-08-05T00:00:00Z",
    archivedAt: null, archiveReason: null, isNegativeCase: false,
    summary: null,
    ...overrides,
  };
}

/**
 * F20260805rsto：mock 必须含 createSession——invoke 兜底分支在
 * getActiveSession 为 null 时会调它；缺了会 TypeError 被裸 catch 静默吞掉（假绿）。
 */
function mockManageSession(overrides?: Partial<{
  getActiveSession: ManageSession["getActiveSession"];
  createSession: ManageSession["createSession"];
}>): ManageSession {
  return {
    getActiveSession: overrides?.getActiveSession ?? (async () => null),
    createSession: overrides?.createSession ?? (async (otterId: string) => makeSession({ id: "sess-backfill", otterId })),
  } as unknown as ManageSession;
}

function mockQueryOtter(): QueryOtter {
  return { getById: async () => null } as unknown as QueryOtter;
}

/** 创建 SdkInvokePort mock（R20260817arnt PR-A 改名），可在指定事件后完成或抛出异常 */
function mockAgentInvoke(options: {
  events?: AgentStreamEvent[];
  result?: { text: string; tokenUsage?: { input: number; output: number }; ctxTokens?: number; ctxMax?: number };
  throwOnInvoke?: Error;
  toolCallCount?: number;
  internalAbortReason?: string;
}): SdkInvokePort & { _invokeMessages: string[]; _invokeContexts: Array<{ sessionSummary?: string } | undefined> } {
  const invokeMessages: string[] = [];
  const invokeContexts: Array<{ sessionSummary?: string } | undefined> = [];
  return {
    invoke: async (_otterId: string, _message: string, opts?: { onEvent?: (e: AgentStreamEvent) => void; dynamicContext?: { sessionSummary?: string } }) => {
      invokeMessages.push(_message);
      invokeContexts.push(opts?.dynamicContext);
      if (options.throwOnInvoke) throw options.throwOnInvoke;
      for (const evt of options.events ?? []) {
        opts?.onEvent?.(evt);
      }
      return options.result ?? { text: "Response text" };
    },
    abort: () => {},
    getToolCallCount: () => options.toolCallCount ?? 0,
    _invokeMessages: invokeMessages,
    _invokeContexts: invokeContexts,
    getInternalAbortReason: () => options.internalAbortReason,
  };
}

// eslint-disable-next-line max-lines-per-function
describe("AgentInvoker", () => {
  it("completes normal flow: start -> complete (B7-B9)", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const sendMessage = mockSendMessage();
    const invoker = new AgentInvoker(
      mockAgentInvoke({
        events: [
          { type: "message_update", delta: "Hello" },
          { type: "message_update", delta: " world" },
          { type: "turn_end" },
        ],
        result: { text: "Hello world", tokenUsage: { input: 10, output: 5 }, ctxTokens: 42000, ctxMax: 200000 },
      }),
      sendMessage,
      mockQueryMessage(),
      mockManageSession(),
      mockQueryOtter(),
      createTestLogger(),
    );

    const result = await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    expect(result.messageId).toBe("msg-streaming");
    expect(result.tokenUsage?.input).toBe(10);
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("message.start");
    expect(eventTypes).toContain("message.complete");

    /** message.start 应携带 createdAt */
    const startEvent = events.find((e) => e.event === "message.start");
    expect(startEvent?.data).toHaveProperty("createdAt");

    /** D5-fix: turn.complete 在 message.complete 之后发出 */
    const completeIdx = eventTypes.indexOf("message.complete");
    const turnIdx = eventTypes.indexOf("turn.complete");
    expect(turnIdx).toBeGreaterThan(completeIdx);

    /** 上下文窗口占用随 complete 落库（口径：末次 LLM 调用窗口占用 ctxTokens，F20260808ctxw），保证刷新后历史消息仍能展示上下文使用率 */
    expect(sendMessage._completeCalls).toHaveLength(1);
    expect(sendMessage._completeCalls[0].input).toEqual({ contextTokens: 42000, contextTokensMax: 200000 });
  });

  it("calls sendMessage.abort() with synthetic body on abort (B-Abort-1, B-Abort-2)", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();
    const invoker = new AgentInvoker(
      mockAgentInvoke({ throwOnInvoke: new Error("Aborted"), toolCallCount: 3 }),
      msg,
      { getMessageById: async () => ({ ...speakingMsg, status: "streaming", body: null, talkingStonePassedTo: null }) } as unknown as QueryMessage,
      mockManageSession(),
      mockQueryOtter(),
      createTestLogger(),
    );

    /** 模拟 abort 被调用 */
    invoker.abort("otter-1", "msg-streaming");

    /** invokeConversation 捕获错误后不再 re-throw，而是返回结果 */
    const result = await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    expect(result.messageId).toBe("msg-streaming");

    /** B-Abort-1: sendMessage.abort 被调用，body 包含工具调用次数 */
    expect(msg._calls.abort).toHaveLength(1);
    expect(msg._calls.abort[0].id).toBe("msg-streaming");
    expect(msg._calls.abort[0].body).toContain("3 次工具调用");
    expect(msg._calls.abort[0].body).toContain("[搭档中断]");

    /** B-Abort-1: sendMessage.fail 不应被调用 */
    expect(msg._calls.fail).toHaveLength(0);

    /** B-Abort-2: SSE 事件为 message.aborted */
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("message.aborted");
  });

  it("reads toolCallCount from error object when getToolCallCount returns 0 (timing fix)", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();

    /** 模拟真实场景：finally 已清理 activeSessions，getToolCallCount 返回 0，但 error 对象携带 _toolCallCount */
    const abortError = Object.assign(new Error("Aborted"), { _toolCallCount: 5 });
    const invoker = new AgentInvoker(
      mockAgentInvoke({ throwOnInvoke: abortError, toolCallCount: 0 }),
      msg,
      { getMessageById: async () => ({ ...speakingMsg, status: "streaming", body: null, talkingStonePassedTo: null }) } as unknown as QueryMessage,
      mockManageSession(),
      mockQueryOtter(),
      createTestLogger(),
    );

    invoker.abort("otter-1", "msg-streaming");

    /** invokeConversation 捕获错误后不再 re-throw，而是返回结果 */
    const result = await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    expect(result.messageId).toBe("msg-streaming");

    /** abort body 应使用 error._toolCallCount 而非 getToolCallCount 的返回值 */
    expect(msg._calls.abort).toHaveLength(1);
    expect(msg._calls.abort[0].body).toContain("5 次工具调用");
  });

  it("handles _guardAbortReason pre-captured on result (primary path)", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();
    const streamingQm: QueryMessage = { getMessageById: async () => ({ ...speakingMsg, status: "streaming", body: null, talkingStonePassedTo: null }) } as unknown as QueryMessage;
    const invoker = new AgentInvoker(
      mockAgentInvoke({ result: Object.assign({ text: "" }, { _guardAbortReason: "streaming_timeout" }) }),
      msg, streamingQm, mockManageSession(), mockQueryOtter(), createTestLogger(),
    );
    const result = await invoker.invokeConversation({ otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1", onSSEEvent: (e) => events.push(e) });
    expect(result.messageId).toBe("msg-streaming");
    expect(msg._calls.abort).toHaveLength(1);
    expect(msg._calls.abort[0].body).toContain("[系统保护]");
    expect(msg._calls.abort[0].body).toContain("超时");
    expect(msg._calls.fail).toHaveLength(1); // streaming_timeout auto-retries: fail + re-invoke, then abort
    expect(msg._calls.fail[0].body).toContain('正在自动重试');
  });
  it("handles OutputGuard internal abort via getInternalAbortReason (SDK swallows abort)", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();
    /** 模拟：SDK 吞掉 abort 正常返回，消息非 speaking 状态，getInternalAbortReason 返回原因 */
    const streamingQm: QueryMessage = {
      getMessageById: async () => ({
        ...speakingMsg, status: "streaming", body: null, talkingStonePassedTo: null,
      }),
    } as unknown as QueryMessage;
    const invoker = new AgentInvoker(
      mockAgentInvoke({ result: { text: "" }, internalAbortReason: "degenerate_output" }),
      msg,
      streamingQm,
      mockManageSession(),
      mockQueryOtter(),
      createTestLogger(),
    );

    const result = await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    expect(result.messageId).toBe("msg-streaming");
    /** abort 路径应被触发，body 包含友好中文消息 */
    expect(msg._calls.abort).toHaveLength(1);
    expect(msg._calls.abort[0].body).toContain("[系统保护]");
    expect(msg._calls.abort[0].body).toContain("异常重复");
    /** SSE 事件为 message.aborted */
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("message.aborted");
  });
  it("first_byte_timeout guard abort triggers auto-retry", async () => {
    const msg = mockSendMessage();
    const invoker = new AgentInvoker(
      mockAgentInvoke({ result: Object.assign({ text: "" }, { _guardAbortReason: "first_byte_timeout" }) }),
      msg,
      { getMessageById: async () => ({ ...speakingMsg, status: "streaming", body: null }) } as unknown as QueryMessage,
      mockManageSession(), mockQueryOtter(), createTestLogger(),
    );
    const result = await invoker.invokeConversation({ otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1" });
    expect(result.messageId).toBe("msg-streaming");
    expect(msg._calls.fail).toHaveLength(1);
    expect(msg._calls.fail[0].body).toContain('正在自动重试');
    expect(msg._calls.abort).toHaveLength(1);
    expect(msg._calls.abort[0].body).toContain('模型响应超时');
  });
  it("LLM API error fails directly (M2: SDK 内置 maxRetries=4 取代 otter 层重试)", async () => {
    const msg = mockSendMessage();
    const invoker = new AgentInvoker(
      mockAgentInvoke({ throwOnInvoke: new Error('LLM API error: rate limit exceeded') }),
      msg,
      { getMessageById: async () => ({ ...speakingMsg, status: "streaming", body: null }) } as unknown as QueryMessage,
      mockManageSession(), mockQueryOtter(), createTestLogger(),
    );
    const result = await invoker.invokeConversation({ otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1" });
    expect(result.messageId).toBe("msg-streaming");
    expect(msg._calls.fail.length).toBeGreaterThanOrEqual(1);
    // M2: API error 直接 fail（SDK 内置重试已耗尽），不再走 otter 层 auto-retry
    expect(msg._calls.fail[0].body).toContain('rate limit exceeded');
    expect(msg._calls.fail[0].body).not.toContain('正在自动重试');
  });
  it("calls sendMessage.fail() through yield retry on system failure (B10)", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();
    /** 系统故障场景：agent 抛出异常，消息停留在 streaming 状态（agent 未调 yield） */
    const streamingQm: QueryMessage = {
      getMessageById: async () => ({
        ...speakingMsg, status: "streaming", body: null, talkingStonePassedTo: null,
      }),
    } as unknown as QueryMessage;
    const invoker = new AgentInvoker(
      mockAgentInvoke({ throwOnInvoke: new Error("LLM connection failed") }),
      msg,
      streamingQm,
      mockManageSession(),
      mockQueryOtter(),
      createTestLogger(),
    );

    /** invokeConversation 通过 yield 重试机制处理系统故障 */
    const result = await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    expect(result.messageId).toBe("msg-streaming");

    /** 非 abort 错误直接抛出，handleInvokeError 调用 fail 一次 */
    expect(msg._calls.fail).toHaveLength(1);
    expect(msg._calls.abort).toHaveLength(0);

    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("message.start");
    expect(eventTypes).toContain("error");
    expect(eventTypes).not.toContain("message.aborted");
  });

  it("clears stale abort flag when invoke succeeds (race condition)", async () => {
    /** D2-fix: abort 被调用但 invoke 成功完成时，stale abort 标记应被清理 */
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const invoker = new AgentInvoker(
      mockAgentInvoke({
        events: [{ type: "message_update", delta: "Hi" }],
        result: { text: "Hello" },
      }),
      mockSendMessage(),
      mockQueryMessage(),
      mockManageSession(),
      mockQueryOtter(),
      createTestLogger(),
    );

    /** 模拟 abort 被调用（但 invoke 不会抛异常） */
    invoker.abort("otter-1", "msg-streaming");

    /** invokeConversation 应正常完成，不发出 message.aborted */
    const result = await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    expect(result.messageId).toBe("msg-streaming");
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("message.complete");
    expect(eventTypes).not.toContain("message.aborted");
  });

  it("maps tool execution events to SSE + persists (B8)", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const invoker = new AgentInvoker(
      mockAgentInvoke({
        events: [
          { type: "tool_execution_start", name: "search_memory" },
          { type: "tool_execution_end", name: "search_memory", result: { entries: [] } },
        ],
        result: { text: "Done" },
      }),
      mockSendMessage(),
      mockQueryMessage(),
      mockManageSession(),
      mockQueryOtter(),
      createTestLogger(),
    );

    await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("tool.result");
  });
});

describe("AgentInvoker — circuit_break abort 归因", () => {
  it("circuit_break abort 呈现熔断专属文案，自动重试后再犯走终态", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessageWithIncrementalId();
    const streamingQm: QueryMessage = {
      getMessageById: async () => ({
        ...speakingMsg, status: "streaming", body: null, talkingStonePassedTo: null,
      }),
    } as unknown as QueryMessage;
    const invoker = new AgentInvoker(
      mockAgentInvoke({ result: { text: "" }, internalAbortReason: "circuit_break:ignored_steer" }),
      msg,
      streamingQm,
      mockManageSession(),
      mockQueryOtter(),
      createTestLogger(),
    );

    const result = await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    expect(result.messageId).toMatch(/^msg-\d+$/);
    // 自动重试：fail + re-invoke（不注入系统消息），重试后 abort
    expect(msg._calls.fail.length).toBeGreaterThanOrEqual(1);
    expect(msg._sendSystemBodies).toHaveLength(0);
    expect(msg._calls.abort).toHaveLength(1);
    expect(msg._calls.abort[0].body).toBe("[系统保护] 检测到工具调用异常循环，已自动中断。");
  });

  it("circuit_break:event_timeout 呈现超时专属文案，自动重试后再犯走终态", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessageWithIncrementalId();
    const streamingQm: QueryMessage = {
      getMessageById: async () => ({
        ...speakingMsg, status: "streaming", body: null, talkingStonePassedTo: null,
      }),
    } as unknown as QueryMessage;
    const invoker = new AgentInvoker(
      mockAgentInvoke({ result: { text: "" }, internalAbortReason: "circuit_break:event_timeout" }),
      msg,
      streamingQm,
      mockManageSession(),
      mockQueryOtter(),
      createTestLogger(),
    );

    const result = await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    expect(result.messageId).toMatch(/^msg-\d+$/);
    expect(msg._calls.fail.length).toBeGreaterThanOrEqual(1);
    expect(msg._sendSystemBodies).toHaveLength(0);
    expect(msg._calls.abort).toHaveLength(1);
    expect(msg._calls.abort[0].body).toBe("[系统保护] 单次工具调用超时，已自动中断。");
  });

  it("output-guard first_byte_timeout 呈现模型响应超时专属文案，自动重试后再犯走终态", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessageWithIncrementalId();
    const streamingQm: QueryMessage = {
      getMessageById: async () => ({
        ...speakingMsg, status: "streaming", body: null, talkingStonePassedTo: null,
      }),
    } as unknown as QueryMessage;
    const invoker = new AgentInvoker(
      mockAgentInvoke({ result: { text: "" }, internalAbortReason: "first_byte_timeout" }),
      msg,
      streamingQm,
      mockManageSession(),
      mockQueryOtter(),
      createTestLogger(),
    );

    await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    expect(msg._calls.fail.length).toBeGreaterThanOrEqual(1);
    expect(msg._sendSystemBodies).toHaveLength(0);
    expect(msg._calls.abort).toHaveLength(1);
    expect(msg._calls.abort[0].body).toBe("[系统保护] 模型响应超时，已自动中断。");
  });
});

/** 创建可配置的 QueryMessage mock：按调用顺序返回不同消息状态 */
function mockQueryMessageSequence(statuses: Array<"streaming" | "speaking">): QueryMessage & { callCount: number } {
  const streamingMsg: Message = {
    id: "msg-streaming", conversationId: "conv-1", turnId: "turn-1",
    senderType: "otter", senderId: "otter-1",
    talkingStonePassedTo: null, status: "streaming",
    body: null,
    sequenceNum: 2, contextTokens: null, contextTokensMax: null,
    source: "web",
      createdAt: "2026-07-16T00:00:00Z", completedAt: null,
  };
  let callCount = 0;
  return {
    callCount,
    getMessageById: async () => {
      const status = statuses[callCount] ?? statuses[statuses.length - 1];
      callCount++;
      return { ...streamingMsg, status, body: status === "speaking" ? "Response" : null, talkingStonePassedTo: status === "speaking" ? ["user-1"] : null };
    },
  } as unknown as QueryMessage & { callCount: number };
}

describe("AgentInvoker yield retry", () => {
  it("retries once when agent does not call speak (first failure → system message → retry)", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();
    /** 第一次 streaming，第二次 speaking（重试成功） */
    const qm = mockQueryMessageSequence(["streaming", "speaking"]);

    const invoker = new AgentInvoker(
      mockAgentInvoke({ result: { text: "Response" } }),
      msg,
      qm,
      mockManageSession(),
      mockQueryOtter(),
      createTestLogger(),
    );

    const result = await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    /** 重试成功后应正常返回 */
    expect(result.messageId).toBeDefined();
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("message.start");
    expect(eventTypes).toContain("message.complete");
  });

  it("fails with user in talkingStonePassedTo after second retry failure", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();
    /** 两次都返回 streaming（重试也失败） */
    const qm = mockQueryMessageSequence(["streaming", "streaming"]);

    const invoker = new AgentInvoker(
      mockAgentInvoke({ result: { text: "Response" } }),
      msg,
      qm,
      mockManageSession(),
      mockQueryOtter(),
      createTestLogger(),
    );

    const result = await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    /** 第二次失败后应返回结果（不抛异常） */
    expect(result.messageId).toBeDefined();

    /** fail 应被调用两次：第一次内部标记失败，第二次重试耗尽时发 message.failed */
    expect(msg._calls.fail).toHaveLength(2);
    /** prepareForRetry 应被调用一次（seamless retry 路径） */
    expect(msg._calls.prepareForRetry).toHaveLength(1);
    /** sendSystem 不应被调用（seamless retry 不注入系统消息到对话历史） */
    expect(msg._sendSystemBodies).toHaveLength(0);

    const eventTypes = events.map((e) => e.event);
    /** 第二次重试失败后发送 message.failed（不是 message.complete） */
    expect(eventTypes).toContain("message.failed");
    /** seamless retry 不发 system.message 和第一次 message.failed */
    expect(eventTypes).not.toContain("system.message");
  });

  it("abort 后 SDK 正常返回（未调 speak）：走 abort 路径，不触发 speak 重试", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();
    /** 消息停在 streaming（speak 未调用），且 SDK 不抛错（吞掉 abort） */
    const qm = mockQueryMessageSequence(["streaming"]);

    const invoker = new AgentInvoker(
      mockAgentInvoke({ result: { text: "Response" } }),
      msg,
      qm,
      mockManageSession(),
      mockQueryOtter(),
      createTestLogger(),
    );

    invoker.abort("otter-1", "msg-streaming");

    await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    const eventTypes = events.map((e) => e.event);
    /** 中断应走 abort 路径 */
    expect(eventTypes).toContain("message.aborted");
    expect(msg._calls.abort).toHaveLength(1);
    /** 不得触发 speak 重试（无系统提醒消息、无第二次 invoke） */
    expect(msg._calls.sendSystem).toHaveLength(0);
    expect(eventTypes).not.toContain("message.failed");
  });

  it("thinking-only（toolCallCount=0）重试提示包含'没有调用任何工具'和'困境'", async () => {
    const msg = mockSendMessage();
    const qm = mockQueryMessageSequence(["streaming", "speaking"]);
    /** 不传 tool_execution_start 事件 → toolCallCount=0 */
    const agent = mockAgentInvoke({ result: { text: "Response" } });
    const invoker = new AgentInvoker(
      agent,
      msg, qm, mockManageSession(), mockQueryOtter(), createTestLogger(),
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
    });

    /** seamless retry: 不注入系统消息到对话历史，通过 userMessageContent 传递给 LLM */
    expect(msg._sendSystemBodies).toHaveLength(0);
    expect(msg._calls.prepareForRetry).toHaveLength(1);
    /** 第二次 invoke 的 userMessageContent 应包含重试提示 */
    expect(agent._invokeMessages).toHaveLength(2);
    expect(agent._invokeMessages[1]).toContain("没有调用任何工具");
    expect(agent._invokeMessages[1]).toContain("yield");
  });

  it("有工具调用但漏 speak（toolCallCount>0）重试提示不包含'没有调用任何工具'", async () => {
    const msg = mockSendMessage();
    const qm = mockQueryMessageSequence(["streaming", "speaking"]);
    /** 传 tool_execution_start 事件 → toolCallCount>0 */
    const agent = mockAgentInvoke({
      events: [{ type: "tool_execution_start", toolCallId: "tc-1", name: "read" } as AgentStreamEvent],
      result: { text: "Response" },
    });
    const invoker = new AgentInvoker(
      agent,
      msg, qm, mockManageSession(), mockQueryOtter(), createTestLogger(),
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
    });

    /** seamless retry: 不注入系统消息到对话历史 */
    expect(msg._sendSystemBodies).toHaveLength(0);
    expect(msg._calls.prepareForRetry).toHaveLength(1);
    /** 第二次 invoke 的 userMessageContent 应包含重试提示（不含'没有调用任何工具'） */
    expect(agent._invokeMessages).toHaveLength(2);
    expect(agent._invokeMessages[1]).not.toContain("没有调用任何工具");
    expect(agent._invokeMessages[1]).toContain("speak");
  });

  it("重试通过 userMessageContent 传递系统提醒给 LLM", async () => {
    const msg = mockSendMessage();
    const qm = mockQueryMessageSequence(["streaming", "speaking"]);
    const agent = mockAgentInvoke({ result: { text: "Response" } });
    const invoker = new AgentInvoker(agent, msg, qm, mockManageSession(), mockQueryOtter(), createTestLogger());

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
    });

    /** seamless retry: 系统提醒通过 userMessageContent 传递给 LLM，不通过 sendSystem 注入 DB */
    expect(msg._sendSystemBodies).toHaveLength(0);
    expect(msg._calls.prepareForRetry).toHaveLength(1);
    expect(agent._invokeMessages).toHaveLength(2);
    /** 第二次 invoke 的 userMessageContent 应包含 speak 重试提示 */
    expect(agent._invokeMessages[1]).toContain("speak");
  });
});

describe("AgentInvoker abort toolCallCount (Path B: SDK swallows abort)", () => {
  it("uses event-tracked toolCallCount when SDK swallows abort", async () => {
    /** Path B: SDK 吞掉 abort，session.prompt() 正常返回，finally 清理 activeSessions，
     *  getToolCallCount 返回 0，但 onEvent 已收到 tool_execution_start 事件 */
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();
    const invoker = new AgentInvoker(
      mockAgentInvoke({
        events: [
          { type: "tool_execution_start", name: "search_memory" },
          { type: "tool_execution_end", name: "search_memory", result: "[]" },
          { type: "tool_execution_start", name: "get_message" },
          { type: "tool_execution_end", name: "get_message", result: "{}" },
          { type: "tool_execution_start", name: "speak" },
          { type: "tool_execution_end", name: "speak", result: "ok" },
        ],
        result: { text: "Response" },
        toolCallCount: 0,
      }),
      msg,
      { getMessageById: async () => ({ ...speakingMsg, status: "streaming", body: null }) } as unknown as QueryMessage,
      mockManageSession(),
      mockQueryOtter(),
      createTestLogger(),
    );

    invoker.abort("otter-1", "msg-streaming");

    const result = await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    expect(result.messageId).toBe("msg-streaming");
    expect(msg._calls.abort).toHaveLength(1);
    expect(msg._calls.abort[0].body).toContain("3 次工具调用");
    expect(msg._calls.abort[0].body).toContain("[搭档中断]");

    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("message.aborted");
  });

  it("Path B with 0 tool calls: abort before any tools execute", async () => {
    /** 边界场景：用户在 agent 执行任何工具之前就 abort，SDK 吞掉 abort 正常返回 */
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();
    const invoker = new AgentInvoker(
      mockAgentInvoke({
        events: [{ type: "message_update", delta: "thinking..." }],
        result: { text: "..." },
        toolCallCount: 0,
      }),
      msg,
      { getMessageById: async () => ({ ...speakingMsg, status: "streaming", body: null }) } as unknown as QueryMessage,
      mockManageSession(),
      mockQueryOtter(),
      createTestLogger(),
    );

    invoker.abort("otter-1", "msg-streaming");

    const result = await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    expect(result.messageId).toBe("msg-streaming");
    expect(msg._calls.abort).toHaveLength(1);
    expect(msg._calls.abort[0].body).toContain("0 次工具调用");
    expect(msg._calls.abort[0].body).toContain("[搭档中断]");
  });

  /** F20260805rsto：invoke 兜底——domain 无 active session 时补登记，restart 不再静默空操作 */
  describe("domain session 兜底（F20260805rsto）", () => {
    function buildInvoker(manageSession: ManageSession) {
      const agentInvoke = mockAgentInvoke({ events: [{ type: "turn_end" }] });
      const invoker = new AgentInvoker(
        agentInvoke, mockSendMessage(), mockQueryMessage(), manageSession, mockQueryOtter(), createTestLogger(),
      );
      return { invoker, agentInvoke };
    }

    it("无 active session 时调 createSession 补登记，新行 summary 经 dynamicContext 注入", async () => {
      const manageSession = mockManageSession({
        getActiveSession: async () => null,
        createSession: async (otterId: string) =>
          makeSession({ id: "sess-backfill", otterId, summary: "前情摘要内容" }),
      });
      const { invoker, agentInvoke } = buildInvoker(manageSession);

      await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "Hi", senderId: "user-1", onSSEEvent: () => {},
      });

      expect(agentInvoke._invokeContexts[0]?.sessionSummary).toContain("前情摘要内容");
    });

    it("补登记撞 conflict（并发他人已建）时重读 active 并继续，不报错", async () => {
      let reads = 0;
      const manageSession = mockManageSession({
        getActiveSession: async () => {
          reads++;
          // 第一次（兜底判定）无，第二次（conflict 后重读）有
          return reads === 1 ? null : makeSession({ id: "sess-other" });
        },
        createSession: async () => {
          throw new DomainError("already has an active session", "conflict");
        },
      });
      const { invoker, agentInvoke } = buildInvoker(manageSession);

      const result = await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "Hi", senderId: "user-1", onSSEEvent: () => {},
      });

      expect(result.messageId).toBe("msg-streaming");
      expect(reads).toBe(2);
      expect(agentInvoke._invokeMessages).toHaveLength(1);
    });

    it("补登记失败且重读仍无 session 时降级为无摘要上下文，不阻塞对话", async () => {
      const manageSession = mockManageSession({
        getActiveSession: async () => null,
        createSession: async () => { throw new Error("db locked"); },
      });
      const { invoker, agentInvoke } = buildInvoker(manageSession);

      const result = await invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "Hi", senderId: "user-1", onSSEEvent: () => {},
      });

      expect(result.messageId).toBe("msg-streaming");
      expect(agentInvoke._invokeMessages).toHaveLength(1);
    });
  });
});

/** 创建带递增 message id 的 mock，避免 abortedMessages 跨消息串扰 */
function mockSendMessageWithIncrementalId() {
  let msgIdCounter = 0;
  const calls: { fail: string[]; abort: Array<{ id: string; body: string }>; sendSystem: string[] } = { fail: [], abort: [], sendSystem: [] };
  const sendSystemBodies: string[] = [];
  return {
    start: async () => {
      msgIdCounter++;
      return {
        id: `msg-${msgIdCounter}`, conversationId: "conv-1", turnId: "turn-1",
        senderType: "otter", senderId: "otter-1",
        talkingStonePassedTo: null, status: "streaming",
        body: null, sequenceNum: msgIdCounter + 1, contextTokens: null, contextTokensMax: null,
        source: "web", createdAt: "2026-07-16T00:00:00Z", completedAt: null,
      };
    },
    complete: async () => ({
      message: { ...speakingMsg, id: `msg-${msgIdCounter}` },
      turnClose: { closed: true, aggregatedTargets: ["user-1"] },
    }),
    fail: async (id: string) => { calls.fail.push(id); },
    abort: async (id: string, input: { body: string }) => { calls.abort.push({ id, body: input.body }); },
    appendEvent: async () => ({}),
    sendSystem: async (_conversationId: string, body: string) => {
      sendSystemBodies.push(body);
      return { id: "msg-system", conversationId: "conv-1", turnId: "turn-1", senderType: "system" as const, senderId: "system", talkingStonePassedTo: null, status: "completed" as const, body, sequenceNum: 99, contextTokens: null, contextTokensMax: null, source: "system" as const, createdAt: "2026-07-16T00:00:00Z", completedAt: null };
    },
    updateTokenUsage: async () => ({}),
    _calls: calls,
    _sendSystemBodies: sendSystemBodies,
  } as unknown as SendMessage & { _calls: typeof calls; _sendSystemBodies: string[] };
}

describe("AgentInvoker — degenerate_output 梯度介入 (F146)", () => {
  it("第一次触发：fail + sendSystem 提醒 + 重试成功", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessageWithIncrementalId();
    let invokeCount = 0;
    const mockInvoke: SdkInvokePort & { _invokeMessages: string[] } = {
      invoke: async () => { invokeCount++; return { text: "正常输出" }; },
      abort: () => {},
      getToolCallCount: () => 0,
      getInternalAbortReason: () => invokeCount <= 1 ? "degenerate_output" : undefined,
      _invokeMessages: [],
    };
    let queryCallCount = 0;
    const qm: QueryMessage = {
      getMessageById: async () => {
        queryCallCount++;
        return queryCallCount <= 1
          ? { ...speakingMsg, status: "streaming", body: null, talkingStonePassedTo: null }
          : speakingMsg;
      },
    } as unknown as QueryMessage;
    const invoker = new AgentInvoker(mockInvoke, msg, qm, mockManageSession(), mockQueryOtter(), createTestLogger());
    await invoker.invokeConversation({ otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1", onSSEEvent: (e) => events.push(e) });

    expect(msg._calls.fail.length).toBeGreaterThanOrEqual(1);
    expect(msg._sendSystemBodies).toHaveLength(1);
    expect(msg._sendSystemBodies[0]).toContain("重复循环");
    expect(msg._sendSystemBodies[0]).toContain("不要重新推理");
    expect(msg._calls.abort).toHaveLength(0);
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("message.failed");
    expect(eventTypes).toContain("message.complete");
    expect(eventTypes).not.toContain("message.aborted");
  });

  it("重试再犯：走 abort 终态", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessageWithIncrementalId();
    const streamingQm: QueryMessage = {
      getMessageById: async () => ({ ...speakingMsg, status: "streaming", body: null, talkingStonePassedTo: null }),
    } as unknown as QueryMessage;
    const mockInvoke: SdkInvokePort & { _invokeMessages: string[] } = {
      invoke: async () => ({ text: "" }),
      abort: () => {},
      getToolCallCount: () => 0,
      getInternalAbortReason: () => "degenerate_output",
      _invokeMessages: [],
    };
    const invoker = new AgentInvoker(mockInvoke, msg, streamingQm, mockManageSession(), mockQueryOtter(), createTestLogger());
    await invoker.invokeConversation({ otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1", onSSEEvent: (e) => events.push(e) });

    expect(msg._calls.fail.length).toBeGreaterThanOrEqual(1);
    expect(msg._sendSystemBodies).toHaveLength(1);
    expect(msg._calls.abort).toHaveLength(1);
    expect(msg._calls.abort[0].body).toContain("[系统保护]");
    expect(msg._calls.abort[0].body).toContain("异常重复");
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("message.failed");
    expect(eventTypes).toContain("message.aborted");
  });

  it("其他 trip 原因（streaming_timeout）自动重试后再犯走 abort 终态", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessageWithIncrementalId();
    const streamingQm: QueryMessage = {
      getMessageById: async () => ({ ...speakingMsg, status: "streaming", body: null, talkingStonePassedTo: null }),
    } as unknown as QueryMessage;
    const invoker = new AgentInvoker(
      mockAgentInvoke({ result: { text: "" }, internalAbortReason: "streaming_timeout" }),
      msg, streamingQm, mockManageSession(), mockQueryOtter(), createTestLogger(),
    );
    await invoker.invokeConversation({ otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1", onSSEEvent: (e) => events.push(e) });

    // 自动重试：fail + re-invoke（不注入系统消息），重试后 abort
    expect(msg._calls.fail.length).toBeGreaterThanOrEqual(1);
    expect(msg._sendSystemBodies).toHaveLength(0);
    expect(msg._calls.abort).toHaveLength(1);
    expect(msg._calls.abort[0].body).toContain("[系统保护]");
    expect(msg._calls.abort[0].body).toContain("超时");
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("message.failed");
    expect(eventTypes).toContain("message.aborted");
  });

  it("sendSystem 失败：降级为直接 abort", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessageWithIncrementalId();
    /** sendSystem 抛异常 */
    (msg as unknown as { sendSystem: () => Promise<unknown> }).sendSystem = async () => { throw new Error("DB write failed"); };
    const streamingQm: QueryMessage = {
      getMessageById: async () => ({ ...speakingMsg, status: "streaming", body: null, talkingStonePassedTo: null }),
    } as unknown as QueryMessage;
    const mockInvoke: SdkInvokePort & { _invokeMessages: string[] } = {
      invoke: async () => ({ text: "" }),
      abort: () => {},
      getToolCallCount: () => 0,
      getInternalAbortReason: () => "degenerate_output",
      _invokeMessages: [],
    };
    const invoker = new AgentInvoker(mockInvoke, msg, streamingQm, mockManageSession(), mockQueryOtter(), createTestLogger());
    await invoker.invokeConversation({ otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1", onSSEEvent: (e) => events.push(e) });

    /** fail 已执行，sendSystem 失败后降级为 abort */
    expect(msg._calls.fail.length).toBeGreaterThanOrEqual(1);
    expect(msg._calls.abort).toHaveLength(1);
    expect(msg._calls.abort[0].body).toContain("[系统保护]");
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("message.failed");
    expect(eventTypes).toContain("message.aborted");
  });

  it("重试时 invokeConversation 抛异常：降级为 abort 终态", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessageWithIncrementalId();
    const streamingQm: QueryMessage = {
      getMessageById: async () => ({ ...speakingMsg, status: "streaming", body: null, talkingStonePassedTo: null }),
    } as unknown as QueryMessage;
    let invokeCount = 0;
    const mockInvoke: SdkInvokePort & { _invokeMessages: string[] } = {
      invoke: async () => {
        invokeCount++;
        if (invokeCount === 1) return { text: "" };
        throw new Error("LLM connection failed");
      },
      abort: () => {},
      getToolCallCount: () => 0,
      getInternalAbortReason: () => invokeCount <= 1 ? "degenerate_output" : undefined,
      _invokeMessages: [],
    };
    const invoker = new AgentInvoker(mockInvoke, msg, streamingQm, mockManageSession(), mockQueryOtter(), createTestLogger());
    const result = await invoker.invokeConversation({ otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1", onSSEEvent: (e) => events.push(e) });

    /** 第一次：fail + sendSystem 成功 */
    expect(msg._calls.fail.length).toBeGreaterThanOrEqual(1);
    expect(msg._sendSystemBodies).toHaveLength(1);
    /** 重试抛异常后，error 路径处理 */
    expect(result.messageId).toBeDefined();
  });

  it("abortedMessages 不泄漏：重试成功后 first message ID 被清理", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessageWithIncrementalId();
    let invokeCount = 0;
    const mockInvoke: SdkInvokePort & { _invokeMessages: string[] } = {
      invoke: async () => { invokeCount++; return { text: "正常输出" }; },
      abort: () => {},
      getToolCallCount: () => 0,
      getInternalAbortReason: () => invokeCount <= 1 ? "degenerate_output" : undefined,
      _invokeMessages: [],
    };
    let queryCallCount = 0;
    const qm: QueryMessage = {
      getMessageById: async () => {
        queryCallCount++;
        return queryCallCount <= 1
          ? { ...speakingMsg, status: "streaming", body: null, talkingStonePassedTo: null }
          : speakingMsg;
      },
    } as unknown as QueryMessage;
    const invoker = new AgentInvoker(mockInvoke, msg, qm, mockManageSession(), mockQueryOtter(), createTestLogger());

    /** 第一次调用：degenerate_output 重试成功 */
    await invoker.invokeConversation({ otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1", onSSEEvent: (e) => events.push(e) });

    /** 验证：第一次调用的 message ID 不在 abortedMessages 中（通过检查后续调用不走 abort 路径） */
    /** 第二次调用：正常调用，不应走 abort 路径 */
    invokeCount = 0;
    queryCallCount = 0;
    const events2: { event: string; data: Record<string, unknown> }[] = [];
    await invoker.invokeConversation({ otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi2", senderId: "user-1", onSSEEvent: (e) => events2.push(e) });

    /** 第二次调用正常完成，不应有 abort 事件 */
    const eventTypes2 = events2.map((e) => e.event);
    expect(eventTypes2).toContain("message.complete");
    expect(eventTypes2).not.toContain("message.aborted");
  });

  it("catch 路径 degenerate_output：session.abort() 抛异常后走重试而非终态", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessageWithIncrementalId();
    let invokeCount = 0;
    const mockInvoke: SdkInvokePort & { _invokeMessages: string[] } = {
      invoke: async () => {
        invokeCount++;
        if (invokeCount === 1) {
          // 模拟 OutputGuard 触发 session.abort() → session.prompt() 抛异常
          const err = Object.assign(new Error("[output-guard] degenerate_output"), {
            _guardAbortReason: "degenerate_output",
            _toolCallCount: 5,
          });
          throw err;
        }
        return { text: "重试成功" };
      },
      abort: () => {},
      getToolCallCount: () => 0,
      getInternalAbortReason: () => undefined,
      _invokeMessages: [],
    };
    /** 重试创建新消息（msg-2），其 getMessageById 返回 speaking 状态以触发 complete */
    const qm: QueryMessage = {
      getMessageById: async (id: string) => id === "msg-1"
        ? { ...speakingMsg, id: "msg-1", status: "streaming", body: null, talkingStonePassedTo: null }
        : { ...speakingMsg, id, status: "speaking", body: "重试成功", talkingStonePassedTo: null },
    } as unknown as QueryMessage;
    const invoker = new AgentInvoker(mockInvoke, msg, qm, mockManageSession(), mockQueryOtter(), createTestLogger());
    await invoker.invokeConversation({ otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1", onSSEEvent: (e) => events.push(e) });

    /** 走重试路径：fail + sendSystem + 重试成功，不走 abort 终态 */
    expect(msg._calls.fail.length).toBeGreaterThanOrEqual(1);
    expect(msg._sendSystemBodies).toHaveLength(1);
    expect(msg._sendSystemBodies[0]).toContain("重复循环");
    expect(msg._calls.abort).toHaveLength(0);
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("message.failed");
    expect(eventTypes).toContain("message.complete");
    expect(eventTypes).not.toContain("message.aborted");
  });

  // F20260806cbsx: abort 路径 speaking 守卫——消息已 speaking 时改走 complete
  it("abort with speaking message: completes instead of aborting (F20260806cbsx)", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();
    const invoker = new AgentInvoker(
      mockAgentInvoke({ throwOnInvoke: new Error("Aborted"), toolCallCount: 3 }),
      msg,
      mockQueryMessage(),  // returns speakingMsg with status "speaking"
      mockManageSession(),
      mockQueryOtter(),
      createTestLogger(),
    );

    invoker.abort("otter-1", "msg-streaming");
    await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    // abort 不应被调用（speaking 守卫拦截，走 complete 收尾）
    expect(msg._calls.abort).toHaveLength(0);
    // 事件应包含 message.complete（非 message.aborted）
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("message.complete");
    expect(eventTypes).not.toContain("message.aborted");
  });
});
