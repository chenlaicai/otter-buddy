import { describe, it, expect } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { AgentInvokePort, AgentStreamEvent } from "@interface-adapters/agent-runtime/agent-invoke-port";
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
  const calls: { fail?: string[]; abort?: Array<{ id: string; body: string }>; sendSystem?: string[] } = { fail: [], abort: [], sendSystem: [] };
  const sendSystemBodies: string[] = [];
  return {
    start: async () => streamingMsg,
    complete: async () => ({ message: completedMsg, turnClose: { closed: true, aggregatedTargets: ["user-1"] } }),
    fail: async (id: string) => { calls.fail!.push(id); },
    abort: async (id: string, input: { body: string }) => { calls.abort!.push({ id, body: input.body }); },
    appendEvent: async () => ({}),
    sendSystem: async (_conversationId: string, body: string) => { sendSystemBodies.push(body); return { ...streamingMsg, id: "msg-system", senderType: "system" as const, status: "completed" as const }; },
    updateTokenUsage: async () => ({}),
    _calls: calls,
    _sendSystemBodies: sendSystemBodies,
  } as unknown as SendMessage & { _calls: { fail: string[]; abort: Array<{ id: string; body: string }>; sendSystem: string[] }; _sendSystemBodies: string[] };
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

/** 创建 AgentInvokePort mock，可在指定事件后完成或抛出异常 */
function mockAgentInvoke(options: {
  events?: AgentStreamEvent[];
  result?: { text: string; tokenUsage?: { input: number; output: number } };
  throwOnInvoke?: Error;
  toolCallCount?: number;
  internalAbortReason?: string;
}): AgentInvokePort & { _invokeMessages: string[]; _invokeContexts: Array<{ sessionSummary?: string } | undefined> } {
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

describe("AgentInvoker", () => {
  it("completes normal flow: start -> complete (B7-B9)", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const invoker = new AgentInvoker(
      mockAgentInvoke({
        events: [
          { type: "message_update", delta: "Hello" },
          { type: "message_update", delta: " world" },
          { type: "turn_end" },
        ],
        result: { text: "Hello world", tokenUsage: { input: 10, output: 5 } },
      }),
      mockSendMessage(),
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
  });

  it("calls sendMessage.abort() with synthetic body on abort (B-Abort-1, B-Abort-2)", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();
    const invoker = new AgentInvoker(
      mockAgentInvoke({ throwOnInvoke: new Error("Aborted"), toolCallCount: 3 }),
      msg,
      mockQueryMessage(),
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
      mockQueryMessage(),
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
    expect(msg._calls.fail).toHaveLength(0);
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

  it("calls sendMessage.fail() through speak retry on system failure (B10)", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();
    /** 系统故障场景：agent 抛出异常，消息停留在 streaming 状态（agent 未调 speak） */
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

    /** invokeConversation 通过 speak 重试机制处理系统故障 */
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
  it("circuit_break abort 呈现熔断专属文案，不再伪装成输出异常", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();
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

    expect(result.messageId).toBe("msg-streaming");
    expect(msg._calls.abort).toHaveLength(1);
    expect(msg._calls.abort[0].body).toBe("[系统保护] 检测到工具调用异常循环，已自动中断。");
  });

  it("circuit_break:event_timeout 呈现超时专属文案", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();
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

    expect(result.messageId).toBe("msg-streaming");
    expect(msg._calls.abort).toHaveLength(1);
    expect(msg._calls.abort[0].body).toBe("[系统保护] 单次工具调用超时，已自动中断。");
  });

  it("output-guard first_byte_timeout 呈现模型响应超时专属文案", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();
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

describe("AgentInvoker speak retry", () => {
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

    /** fail 应被调用两次：第一次无 talkingStonePassedTo，第二次含 senderId */
    expect(msg._calls.fail).toHaveLength(2);

    const eventTypes = events.map((e) => e.event);
    /** 第二次重试失败后发送 message.failed（不是 message.complete） */
    expect(eventTypes).toContain("message.failed");
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
    const invoker = new AgentInvoker(
      mockAgentInvoke({ result: { text: "Response" } }),
      msg, qm, mockManageSession(), mockQueryOtter(), createTestLogger(),
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
    });

    expect(msg._sendSystemBodies).toHaveLength(1);
    expect(msg._sendSystemBodies[0]).toContain("没有调用任何工具");
    expect(msg._sendSystemBodies[0]).toContain("困境");
  });

  it("有工具调用但漏 speak（toolCallCount>0）重试提示不包含'没有调用任何工具'", async () => {
    const msg = mockSendMessage();
    const qm = mockQueryMessageSequence(["streaming", "speaking"]);
    /** 传 tool_execution_start 事件 → toolCallCount>0 */
    const invoker = new AgentInvoker(
      mockAgentInvoke({
        events: [{ type: "tool_execution_start", toolCallId: "tc-1", name: "read" } as AgentStreamEvent],
        result: { text: "Response" },
      }),
      msg, qm, mockManageSession(), mockQueryOtter(), createTestLogger(),
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
    });

    expect(msg._sendSystemBodies).toHaveLength(1);
    expect(msg._sendSystemBodies[0]).not.toContain("没有调用任何工具");
    expect(msg._sendSystemBodies[0]).toContain("speak");
  });

  it("sendSystem 与 userMessageContent 使用相同的重试文本", async () => {
    const msg = mockSendMessage();
    const qm = mockQueryMessageSequence(["streaming", "speaking"]);
    const agent = mockAgentInvoke({ result: { text: "Response" } });
    const invoker = new AgentInvoker(agent, msg, qm, mockManageSession(), mockQueryOtter(), createTestLogger());

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
    });

    /** sendSystem body（DB/前端）与第二次 invoke 的 userMessageContent（LLM）应一致 */
    expect(msg._sendSystemBodies).toHaveLength(1);
    expect(agent._invokeMessages).toHaveLength(2);
    expect(msg._sendSystemBodies[0]).toBe(agent._invokeMessages[1]);
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

describe("AgentInvoker — degenerate_output 梯度介入 (F146)", () => {
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

  it("第一次触发：fail + sendSystem 提醒 + 重试成功", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessageWithIncrementalId();
    let invokeCount = 0;
    const mockInvoke: AgentInvokePort & { _invokeMessages: string[] } = {
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
    const mockInvoke: AgentInvokePort & { _invokeMessages: string[] } = {
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

  it("其他 trip 原因（streaming_timeout）直接走 abort 终态", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();
    const streamingQm: QueryMessage = {
      getMessageById: async () => ({ ...speakingMsg, status: "streaming", body: null, talkingStonePassedTo: null }),
    } as unknown as QueryMessage;
    const invoker = new AgentInvoker(
      mockAgentInvoke({ result: { text: "" }, internalAbortReason: "streaming_timeout" }),
      msg, streamingQm, mockManageSession(), mockQueryOtter(), createTestLogger(),
    );
    await invoker.invokeConversation({ otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1", onSSEEvent: (e) => events.push(e) });

    expect(msg._calls.abort).toHaveLength(1);
    expect(msg._calls.abort[0].body).toContain("[系统保护]");
    expect(msg._calls.abort[0].body).toContain("超时");
    expect(msg._calls.fail).toHaveLength(0);
    expect(msg._sendSystemBodies).toHaveLength(0);
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("message.aborted");
    expect(eventTypes).not.toContain("message.failed");
  });

  it("sendSystem 失败：降级为直接 abort", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessageWithIncrementalId();
    /** sendSystem 抛异常 */
    (msg as unknown as { sendSystem: () => Promise<unknown> }).sendSystem = async () => { throw new Error("DB write failed"); };
    const streamingQm: QueryMessage = {
      getMessageById: async () => ({ ...speakingMsg, status: "streaming", body: null, talkingStonePassedTo: null }),
    } as unknown as QueryMessage;
    const mockInvoke: AgentInvokePort & { _invokeMessages: string[] } = {
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
    const mockInvoke: AgentInvokePort & { _invokeMessages: string[] } = {
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
    const mockInvoke: AgentInvokePort & { _invokeMessages: string[] } = {
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
});
