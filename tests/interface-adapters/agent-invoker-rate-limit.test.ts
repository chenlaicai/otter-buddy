/**
 * #543：模型限流 429 终态的编排层感知集成测试。
 *
 * 验收（issue 原文）：模拟 429 响应 → 断言 healing 落账 + 通知路径。
 * 链路：mockAgentInvoke 抛 LLM API error（checkSessionError 终端形态）
 * → orchestrator api_error 分类 → handleApiError 识别 → 落账 + sendSystem + failTerminal。
 */
import { describe, it, expect } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SdkInvokePort } from "@usecases/ports/sdk-invoke-port";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Message } from "@entities/conversation/message";
import type { HealingEvent } from "@entities/healing/healing-event";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import { createTestLogger } from "../helpers/logger";

const streamingMsg: Message = {
  id: "msg-streaming", conversationId: "conv-1", turnId: "turn-1",
  senderType: "otter", senderId: "otter-1",
  talkingStonePassedTo: null, status: "streaming",
  segments: [], sequenceNum: 2, contextTokens: null, contextTokensMax: null,
  source: "web", senderName: "Test Otter",
  createdAt: "2026-09-02T00:00:00Z", completedAt: null,
};

function mockSendMessage() {
  const failCalls: Array<{ id: string; body?: string }> = [];
  const sendSystemBodies: string[] = [];
  return {
    start: async () => streamingMsg,
    complete: async () => ({}),
    fail: async (id: string, body?: string) => { failCalls.push({ id, body }); },
    abort: async () => ({}),
    appendEvent: async () => ({}),
    sendSystem: async (_convId: string, body: string) => {
      sendSystemBodies.push(body);
      return { ...streamingMsg, id: `msg-sys-${sendSystemBodies.length}`, senderType: "system" as const, status: "completed" as const, segments: [{ id: `seg-sys-${sendSystemBodies.length}`, messageId: `msg-sys-${sendSystemBodies.length}`, body, sequenceNum: 1, createdAt: "2026-09-02T00:00:00Z" }], talkingStonePassedTo: [] };
    },
    updateTokenUsage: async () => ({}),
    prepareForRetry: async () => ({}),
    _failCalls: failCalls,
    _sendSystemBodies: sendSystemBodies,
  } as unknown as SendMessage & { _failCalls: Array<{ id: string; body?: string }>; _sendSystemBodies: string[] };
}

/** 抛 429 终态错误的 SDK mock——错误带 _modelAlias 元数据（pi-session-factory catch 块同款） */
function mockAgentInvokeThrowing(err: Error & { _modelAlias?: string }): SdkInvokePort {
  return {
    invoke: async () => { throw err; },
    abort: () => {},
    getToolCallCount: () => 0,
    getInternalAbortReason: () => undefined,
  } as unknown as SdkInvokePort;
}

function mockHealingRepo(): HealingEventRepository & { _events: HealingEvent[] } {
  const events: HealingEvent[] = [];
  return {
    _events: events,
    create: async (e: HealingEvent) => { events.push(e); },
    findRecentByOtter: async () => [],
    findOpen: async () => [],
    findAll: async () => [],
    findById: async () => null,
    findByConversation: async () => [],
    updateStatus: async () => {},
    resolve: async () => {},
    getStats: async () => ({ open: 0, resolved: 0, dismissed: 0, byType: {}, bySeverity: {} }),
    autoStaleDismiss: async () => 0,
    batchResolveByFilter: async () => ({ matched: 0, resolved: 0, resolvedIds: [] }),
  } as unknown as HealingEventRepository & { _events: HealingEvent[] };
}

function makeInvoker(agentInvoke: SdkInvokePort, msg: ReturnType<typeof mockSendMessage>, healingRepo?: HealingEventRepository) {
  const queryMessage = { getMessageById: async () => ({ ...streamingMsg, status: "failed" }) } as unknown as QueryMessage;
  const manageSession = { getActiveSession: async () => null, createSession: async () => null } as unknown as ManageSession;
  const queryOtter = { getById: async () => ({ id: "otter-1", name: "检视獭", type: "small" }) } as unknown as QueryOtter;
  return new AgentInvoker(
    agentInvoke, msg, queryMessage, manageSession, queryOtter, createTestLogger(),
    undefined, // messageBroadcaster
    undefined, // workspaceGateway
    undefined, // settingsRepo
    undefined, // metrics
    healingRepo,
  );
}

describe("AgentInvoker rate limit alerting (#543)", () => {
  it("配额耗尽 429 → healing 落账（high + modelAlias + resetHint）+ 系统告警 + 消息 fail", async () => {
    const msg = mockSendMessage();
    const healingRepo = mockHealingRepo();
    const err = Object.assign(
      new Error('LLM API error: {"code":"1310","message":"code: 1310, 本周配额已耗尽，将于 2026-09-04 20:22 重置"}'),
      { _modelAlias: "glm" },
    );
    const invoker = makeInvoker(mockAgentInvokeThrowing(err), msg, healingRepo);

    const result = await invoker.invokeConversation({ otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1" });

    // 主路径不受影响：消息仍 fail
    expect(result.messageId).toBe("msg-streaming");
    expect(msg._failCalls.length).toBeGreaterThanOrEqual(1);

    // ① healing 落账
    const rl = healingRepo._events.find(e => e.errorType === "rate_limit");
    expect(rl).toBeDefined();
    expect(rl!.severity).toBe("high");
    expect(rl!.otterId).toBe("otter-1");
    expect(rl!.conversationId).toBe("conv-1");
    expect((rl!.context as Record<string, unknown>).modelAlias).toBe("glm");
    expect((rl!.context as Record<string, unknown>).exhausted).toBe(true);
    expect((rl!.context as Record<string, unknown>).resetHint).toBeTruthy();

    // ② 通知：系统告警消息可见
    expect(msg._sendSystemBodies.length).toBeGreaterThanOrEqual(1);
    const alert = msg._sendSystemBodies.find(b => b.includes("[系统告警]"));
    expect(alert).toBeDefined();
    expect(alert).toContain("glm");
    expect(alert).toContain("改派");
  });

  it("瞬时限流 429（重试耗尽）→ severity=medium 告警", async () => {
    const msg = mockSendMessage();
    const healingRepo = mockHealingRepo();
    const err = Object.assign(new Error("LLM API error: Rate limit exceeded after 4 retries"), { _modelAlias: "glm-flash" });
    const invoker = makeInvoker(mockAgentInvokeThrowing(err), msg, healingRepo);

    await invoker.invokeConversation({ otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1" });

    const rl = healingRepo._events.find(e => e.errorType === "rate_limit");
    expect(rl).toBeDefined();
    expect(rl!.severity).toBe("medium");
    expect(msg._sendSystemBodies.some(b => b.includes("限流"))).toBe(true);
  });

  it("非限流 API 错误 → 无 rate_limit 落账、无系统告警（不误报）", async () => {
    const msg = mockSendMessage();
    const healingRepo = mockHealingRepo();
    const err = Object.assign(new Error("LLM API error: connection reset by peer"), { _modelAlias: "glm" });
    const invoker = makeInvoker(mockAgentInvokeThrowing(err), msg, healingRepo);

    await invoker.invokeConversation({ otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1" });

    expect(healingRepo._events.find(e => e.errorType === "rate_limit")).toBeUndefined();
    expect(msg._sendSystemBodies).toHaveLength(0);
    expect(msg._failCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("healing 落账失败不阻断 fail 主路径", async () => {
    const msg = mockSendMessage();
    const brokenRepo = {
      create: async () => { throw new Error("db locked"); },
      findRecentByOtter: async () => [],
      findOpen: async () => [],
    } as unknown as HealingEventRepository;
    const err = Object.assign(new Error("LLM API error: 429 quota exceeded"), { _modelAlias: "glm" });
    const invoker = makeInvoker(mockAgentInvokeThrowing(err), msg, brokenRepo);

    const result = await invoker.invokeConversation({ otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1" });
    // 落账炸了，消息照常 fail，通知照发
    expect(result.messageId).toBe("msg-streaming");
    expect(msg._failCalls.length).toBeGreaterThanOrEqual(1);
    expect(msg._sendSystemBodies.some(b => b.includes("[系统告警]"))).toBe(true);
  });

  it("无 healingRepo 注入（测试装配/降级）→ 仍发系统告警，不炸", async () => {
    const msg = mockSendMessage();
    const err = Object.assign(new Error("LLM API error: 429 insufficient_quota"), { _modelAlias: "glm" });
    const invoker = makeInvoker(mockAgentInvokeThrowing(err), msg, undefined);

    const result = await invoker.invokeConversation({ otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1" });
    expect(result.messageId).toBe("msg-streaming");
    expect(msg._sendSystemBodies.some(b => b.includes("[系统告警]"))).toBe(true);
  });
});
