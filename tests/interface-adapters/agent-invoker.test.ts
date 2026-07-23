import { describe, it, expect } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { AgentInvokePort, AgentStreamEvent } from "@interface-adapters/agent-runtime/agent-invoke-port";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Message } from "@entities/conversation/message";
import type { Logger } from "@usecases/ports/logger";

const speakingMsg: Message = {
  id: "msg-streaming", conversationId: "conv-1", turnId: "turn-1",
  senderType: "otter", senderId: "otter-1",
  talkingStonePassedTo: ["user-1"], status: "speaking",
  body: "Response", attachments: null,
  sequenceNum: 2, contextTokens: null, contextTokensMax: null,
  createdAt: "2026-07-16T00:00:00Z", completedAt: null,
};

const completedMsg: Message = {
  id: "msg-streaming", conversationId: "conv-1", turnId: "turn-1",
  senderType: "otter", senderId: "otter-1",
  talkingStonePassedTo: ["user-1"], status: "completed",
  body: "Response", attachments: null,
  sequenceNum: 2, contextTokens: null, contextTokensMax: null,
  createdAt: "2026-07-16T00:00:00Z", completedAt: "2026-07-16T00:00:01Z",
};

/** 创建 SendMessage mock，记录调用并返回模拟消息 */
function mockSendMessage() {
  const streamingMsg: Message = {
    id: "msg-streaming", conversationId: "conv-1", turnId: "turn-1",
    senderType: "otter", senderId: "otter-1",
    talkingStonePassedTo: null, status: "streaming",
    body: null, attachments: null,
    sequenceNum: 2, contextTokens: null, contextTokensMax: null,
    createdAt: "2026-07-16T00:00:00Z", completedAt: null,
  };
  const calls: { fail?: string[]; abort?: Array<{ id: string; body: string }>; sendSystem?: string[] } = { fail: [], abort: [], sendSystem: [] };
  return {
    start: async () => streamingMsg,
    complete: async () => ({ message: completedMsg, turnClose: { closed: true, aggregatedTargets: ["user-1"] } }),
    fail: async (id: string) => { calls.fail!.push(id); },
    abort: async (id: string, input: { body: string }) => { calls.abort!.push({ id, body: input.body }); },
    appendEvent: async () => ({}),
    sendSystem: async () => ({ ...streamingMsg, id: "msg-system", senderType: "system" as const, status: "completed" as const }),
    updateTokenUsage: async () => ({}),
    _calls: calls,
  } as unknown as SendMessage & { _calls: { fail: string[]; abort: Array<{ id: string; body: string }>; sendSystem: string[] } };
}

function mockQueryMessage(): QueryMessage {
  return { getMessageById: async () => speakingMsg } as unknown as QueryMessage;
}

function mockManageSession(): ManageSession {
  return { getActiveSession: async () => null } as unknown as ManageSession;
}

function mockQueryOtter(): QueryOtter {
  return { getById: async () => null } as unknown as QueryOtter;
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

/** 创建 AgentInvokePort mock，可在指定事件后完成或抛出异常 */
function mockAgentInvoke(options: {
  events?: AgentStreamEvent[];
  result?: { text: string; tokenUsage?: { input: number; output: number } };
  throwOnInvoke?: Error;
  toolCallCount?: number;
}): AgentInvokePort {
  return {
    invoke: async (_otterId: string, _message: string, opts?: { onEvent?: (e: AgentStreamEvent) => void }) => {
      if (options.throwOnInvoke) throw options.throwOnInvoke;
      for (const evt of options.events ?? []) {
        opts?.onEvent?.(evt);
      }
      return options.result ?? { text: "Response text" };
    },
    abort: () => {},
    getToolCallCount: () => options.toolCallCount ?? 0,
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
      mockLogger(),
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
      mockLogger(),
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
    expect(msg._calls.abort[0].body).toContain("[用户中断]");

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
      mockLogger(),
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
      mockLogger(),
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

    /** speak 重试机制：fail 被调用两次（初始 + 重试），abort 不被调用 */
    expect(msg._calls.fail).toHaveLength(2);
    expect(msg._calls.abort).toHaveLength(0);

    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("message.start");
    expect(eventTypes).toContain("message.failed");
    expect(eventTypes).toContain("system.message");
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
      mockLogger(),
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
      mockLogger(),
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

/** 创建可配置的 QueryMessage mock：按调用顺序返回不同消息状态 */
function mockQueryMessageSequence(statuses: Array<"streaming" | "speaking">): QueryMessage & { callCount: number } {
  const streamingMsg: Message = {
    id: "msg-streaming", conversationId: "conv-1", turnId: "turn-1",
    senderType: "otter", senderId: "otter-1",
    talkingStonePassedTo: null, status: "streaming",
    body: null, attachments: null,
    sequenceNum: 2, contextTokens: null, contextTokensMax: null,
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
      mockLogger(),
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
      mockLogger(),
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
});
