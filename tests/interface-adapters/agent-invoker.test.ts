import { describe, it, expect } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { AgentInvokePort, AgentStreamEvent } from "@interface-adapters/agent-runtime/agent-invoke-port";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { SearchMemory } from "@usecases/memory/search-memory";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Message } from "@entities/conversation/message";

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
  return {
    start: async () => streamingMsg,
    complete: async () => ({ ...streamingMsg, status: "completed", body: "Response" }),
    fail: async () => {},
    appendEvent: async () => ({}),
  } as unknown as SendMessage;
}

function mockSearchMemory(): SearchMemory {
  return { search: async () => ({ entries: [], total: 0 }) } as unknown as SearchMemory;
}

function mockManageSession(): ManageSession {
  return { getActiveSession: async () => null } as unknown as ManageSession;
}

function mockQueryOtter(): QueryOtter {
  return { getById: async () => null } as unknown as QueryOtter;
}

/** 创建 AgentInvokePort mock，可在指定事件后完成或抛出异常 */
function mockAgentInvoke(options: {
  events?: AgentStreamEvent[];
  result?: { text: string; tokenUsage?: { input: number; output: number } };
  throwOnInvoke?: Error;
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
  };
}

describe("AgentInvoker", () => {
  it("completes normal flow: start -> delta -> complete (B7-B9)", async () => {
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
      mockSearchMemory(),
      mockManageSession(),
      mockQueryOtter(),
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
    expect(eventTypes).toContain("message.delta");
    expect(eventTypes).toContain("message.complete");

    /** D5-fix: turn.complete 在 message.complete 之后发出 */
    const completeIdx = eventTypes.indexOf("message.complete");
    const turnIdx = eventTypes.indexOf("turn.complete");
    expect(turnIdx).toBeGreaterThan(completeIdx);

    /** D4-fix: message.complete 包含 ctx 字段 */
    const completeEvent = events.find((e) => e.event === "message.complete");
    expect(completeEvent?.data.ctx).toBe(15);
  });

  it("emits message.aborted on abort (B11)", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const invoker = new AgentInvoker(
      mockAgentInvoke({ throwOnInvoke: new Error("Aborted") }),
      mockSendMessage(),
      mockSearchMemory(),
      mockManageSession(),
      mockQueryOtter(),
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

    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("message.start");
    expect(eventTypes).toContain("message.aborted");
  });

  it("emits error on system failure (B10)", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const invoker = new AgentInvoker(
      mockAgentInvoke({ throwOnInvoke: new Error("LLM connection failed") }),
      mockSendMessage(),
      mockSearchMemory(),
      mockManageSession(),
      mockQueryOtter(),
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
      mockSearchMemory(),
      mockManageSession(),
      mockQueryOtter(),
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
      mockSearchMemory(),
      mockManageSession(),
      mockQueryOtter(),
    );

    await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("tool.start");
    expect(eventTypes).toContain("tool.result");
  });
});
