import { describe, it, expect } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { AgentInvokePort, AgentStreamEvent } from "@interface-adapters/agent-runtime/agent-invoke-port";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Message } from "@entities/conversation/message";
import type { Logger } from "@usecases/ports/logger";

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
  const calls: { fail?: string[]; abort?: Array<{ id: string; body: string }> } = { fail: [], abort: [] };
  return {
    start: async () => streamingMsg,
    complete: async () => ({ ...streamingMsg, status: "completed", body: "Response" }),
    fail: async (id: string) => { calls.fail!.push(id); },
    abort: async (id: string, input: { body: string }) => { calls.abort!.push({ id, body: input.body }); },
    appendEvent: async () => ({}),
    _calls: calls,
  } as unknown as SendMessage & { _calls: { fail: string[]; abort: Array<{ id: string; body: string }> } };
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

    /** D4-fix: message.complete 包含 ctx 字段 */
    const completeEvent = events.find((e) => e.event === "message.complete");
    expect(completeEvent?.data.ctx).toBe(15);
  });

  it("calls sendMessage.abort() with synthetic body on abort (B-Abort-1, B-Abort-2)", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();
    const invoker = new AgentInvoker(
      mockAgentInvoke({ throwOnInvoke: new Error("Aborted"), toolCallCount: 3 }),
      msg,
      mockManageSession(),
      mockQueryOtter(),
      mockLogger(),
    );

    /** 模拟 abort 被调用 */
    invoker.abort("otter-1", "msg-streaming");

    await expect(
      invoker.invokeConversation({
        otterId: "otter-1",
        conversationId: "conv-1",
        userMessageContent: "Hi",
        senderId: "user-1",
        onSSEEvent: (e) => events.push(e),
      }),
    ).rejects.toThrow("Aborted");

    /** B-Abort-1: sendMessage.abort 被调用，body 包含工具调用次数 */
    expect(msg._calls.abort).toHaveLength(1);
    expect(msg._calls.abort[0].id).toBe("msg-streaming");
    expect(msg._calls.abort[0].body).toContain("3 次工具调用");
    expect(msg._calls.abort[0].body).toContain("[用户中断]");

    /** B-Abort-1: sendMessage.fail 不应被调用 */
    expect(msg._calls.fail).toHaveLength(0);

    /** B-Abort-2: SSE 事件为 message.aborted，携带 abortBody */
    const abortEvent = events.find((e) => e.event === "message.aborted");
    expect(abortEvent).toBeDefined();
    expect(abortEvent!.data.abortBody).toContain("[用户中断]");
    expect(abortEvent!.data.abortBody).toContain("3 次工具调用");
  });

  it("reads toolCallCount from error object when getToolCallCount returns 0 (timing fix)", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();

    /** 模拟真实场景：finally 已清理 activeSessions，getToolCallCount 返回 0，但 error 对象携带 _toolCallCount */
    const abortError = Object.assign(new Error("Aborted"), { _toolCallCount: 5 });
    const invoker = new AgentInvoker(
      mockAgentInvoke({ throwOnInvoke: abortError, toolCallCount: 0 }),
      msg,
      mockManageSession(),
      mockQueryOtter(),
      mockLogger(),
    );

    invoker.abort("otter-1", "msg-streaming");

    await expect(
      invoker.invokeConversation({
        otterId: "otter-1",
        conversationId: "conv-1",
        userMessageContent: "Hi",
        senderId: "user-1",
        onSSEEvent: (e) => events.push(e),
      }),
    ).rejects.toThrow("Aborted");

    /** abort body 应使用 error._toolCallCount 而非 getToolCallCount 的返回值 */
    expect(msg._calls.abort).toHaveLength(1);
    expect(msg._calls.abort[0].body).toContain("5 次工具调用");
  });

  it("calls sendMessage.fail() and emits error on system failure (B10)", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const msg = mockSendMessage();
    const invoker = new AgentInvoker(
      mockAgentInvoke({ throwOnInvoke: new Error("LLM connection failed") }),
      msg,
      mockManageSession(),
      mockQueryOtter(),
      mockLogger(),
    );

    await expect(
      invoker.invokeConversation({
        otterId: "otter-1",
        conversationId: "conv-1",
        userMessageContent: "Hi",
        senderId: "user-1",
        onSSEEvent: (e) => events.push(e),
      }),
    ).rejects.toThrow("LLM connection failed");

    /** error 路径：sendMessage.fail 被调用，sendMessage.abort 不被调用 */
    expect(msg._calls.fail).toHaveLength(1);
    expect(msg._calls.abort).toHaveLength(0);

    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("message.start");
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
