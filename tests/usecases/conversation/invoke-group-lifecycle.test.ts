/**
 * F20260909smsp: invoke 消息链生命周期测试（orchestrator 层）
 *
 * 测试 invoke group 的完成/终态化逻辑：
 * - completeInvokeGroupSpeakMessages：正常完成路径（tryCompleteSpeaking 内调用）
 * - terminateInvokeGroupSpeakMessages：fail/abort 路径
 * - getInvokeGroupSpeakMessages：辅助方法
 * - skipSegmentValidation 修复锁定
 * - AT-7: resume 恢复（中断的 speak message 终态化）
 */
import { describe, it, expect, vi } from "vitest";
import { AgentTurnOrchestrator } from "@usecases/conversation/agent-turn-orchestrator/orchestrator";
import type { TurnCallbacks } from "@usecases/conversation/agent-turn-orchestrator/types";
import type { MessageSegment } from "@entities/conversation/message";
import type { Logger } from "@usecases/ports/logger";

/** 构建 mock TurnCallbacks */
function makeCallbacks(opts: {
  invokeGroupMessages?: Array<{ id: string; status: string; segments: MessageSegment[]; turnId?: string; metadata?: { invokeGroupId?: string } }>;
  failMessageError?: string;
  abortMessageError?: string;
} = {}): TurnCallbacks & { _events: Array<{ event: string; data: Record<string, unknown> }>; _failedIds: string[]; _abortedIds: string[]; _completedSpeakIds: string[] } {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const failedIds: string[] = [];
  const abortedIds: string[] = [];
  const completedSpeakIds: string[] = [];

  return {
    completeMessage: async () => ({ turnClose: {} }),
    failMessage: async (id: string) => {
      if (opts.failMessageError) throw new Error(opts.failMessageError);
      failedIds.push(id);
    },
    abortMessage: async (id: string) => {
      if (opts.abortMessageError) throw new Error(opts.abortMessageError);
      abortedIds.push(id);
    },
    recordHealingEvent: async () => {},
    getRecentGuardBounces: async () => 0,
    isSessionCircuitBreakCreated: async () => false,
    isCircuitBreakerEnabled: () => true,
    broadcastMessage: async () => {},
    getMessageById: async (id: string) => {
      // 默认：返回带有 metadata 的消息
      const msg = opts.invokeGroupMessages?.find(m => m.id === id);
      if (msg) return { status: msg.status, segments: msg.segments, turnId: msg.turnId, metadata: msg.metadata };
      // 首个 message 默认
      return { status: 'speaking', segments: [], turnId: 'turn-1', metadata: { invokeGroupId: 'msg-1' } };
    },
    sendSystem: async () => ({ id: 'sys-1', body: '', sequenceNum: 0 }),
    startNewMessage: async () => ({ id: 'new-msg', sequenceNum: 1, createdAt: new Date().toISOString() }),
    prepareForRetry: async () => {},
    getOtterById: async () => ({ name: '大獭', type: 'big' }),
    getPartnerLabel: async () => '搭档',
    emitEvent: (event) => { events.push(event); },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    getMessagesByInvokeGroupId: async (_convId: string, invokeGroupId: string) => {
      return (opts.invokeGroupMessages ?? [])
        .filter(m => m.id === invokeGroupId || m.metadata?.invokeGroupId === invokeGroupId)
        .map(m => ({ id: m.id, status: m.status, segments: m.segments, turnId: m.turnId }));
    },
    completeSpeakMessage: async (id: string) => {
      completedSpeakIds.push(id);
    },
    _events: events,
    _failedIds: failedIds,
    _abortedIds: abortedIds,
    _completedSpeakIds: completedSpeakIds,
  };
}

function makeOrchestrator() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  return new AgentTurnOrchestrator(logger);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private methods for testing
const pvt = (o: AgentTurnOrchestrator) => o as any;

// ─────────────────────────────────────────────────
// completeInvokeGroupSpeakMessages
// ─────────────────────────────────────────────────
describe("completeInvokeGroupSpeakMessages", () => {
  it("完成 invoke group 中所有 speaking 状态的 speak message", async () => {
    const orchestrator = makeOrchestrator();
    const callbacks = makeCallbacks({
      invokeGroupMessages: [
        { id: "msg-1", status: "speaking", segments: [], metadata: { invokeGroupId: "msg-1" } },
        { id: "speak-1", status: "speaking", segments: [{ id: "seg-1", messageId: "speak-1", body: "段一", sequenceNum: 1, createdAt: "2026-09-09" }], turnId: "turn-1", metadata: { invokeGroupId: "msg-1" } },
        { id: "speak-2", status: "speaking", segments: [{ id: "seg-2", messageId: "speak-2", body: "段二", sequenceNum: 1, createdAt: "2026-09-09" }], turnId: "turn-1", metadata: { invokeGroupId: "msg-1" } },
      ],
    });

    const input = { messageId: "msg-1", otterId: "otter-1", conversationId: "conv-1", senderId: "user-1", userMessageContent: "test", retryCount: 0, manualRetry: false };
    await pvt(orchestrator).completeInvokeGroupSpeakMessages(input, 5000, callbacks);

    // 两个 speak message 被完成
    expect(callbacks._completedSpeakIds).toContain("speak-1");
    expect(callbacks._completedSpeakIds).toContain("speak-2");
    // 首个 message 不被完成（由 tryCompleteSpeaking 处理）
    expect(callbacks._completedSpeakIds).not.toContain("msg-1");
  });

  it("广播 message.complete 事件（每个 speak message 独立事件）", async () => {
    const orchestrator = makeOrchestrator();
    const callbacks = makeCallbacks({
      invokeGroupMessages: [
        { id: "msg-1", status: "speaking", segments: [], metadata: { invokeGroupId: "msg-1" } },
        { id: "speak-1", status: "speaking", segments: [{ id: "seg-1", messageId: "speak-1", body: "内容", sequenceNum: 1, createdAt: "2026-09-09" }], turnId: "turn-1", metadata: { invokeGroupId: "msg-1" } },
      ],
    });

    const input = { messageId: "msg-1", otterId: "otter-1", conversationId: "conv-1", senderId: "user-1", userMessageContent: "test", retryCount: 0, manualRetry: false };
    await pvt(orchestrator).completeInvokeGroupSpeakMessages(input, 5000, callbacks);

    const completeEvents = callbacks._events.filter(e => e.event === "message.complete");
    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0].data.messageId).toBe("speak-1");
    expect(completeEvents[0].data.body).toBe("内容");
  });

  it("跳过已完成的 speak message（不重复完结）", async () => {
    const orchestrator = makeOrchestrator();
    const callbacks = makeCallbacks({
      invokeGroupMessages: [
        { id: "msg-1", status: "speaking", segments: [], metadata: { invokeGroupId: "msg-1" } },
        { id: "speak-1", status: "completed", segments: [], turnId: "turn-1", metadata: { invokeGroupId: "msg-1" } }, // 已完成
        { id: "speak-2", status: "speaking", segments: [], turnId: "turn-1", metadata: { invokeGroupId: "msg-1" } },
      ],
    });

    const input = { messageId: "msg-1", otterId: "otter-1", conversationId: "conv-1", senderId: "user-1", userMessageContent: "test", retryCount: 0, manualRetry: false };
    await pvt(orchestrator).completeInvokeGroupSpeakMessages(input, 5000, callbacks);

    // 只完成 speak-2，不重复完成 speak-1
    expect(callbacks._completedSpeakIds).toContain("speak-2");
    expect(callbacks._completedSpeakIds).not.toContain("speak-1");
  });

  it("invoke group 为空时无操作", async () => {
    const orchestrator = makeOrchestrator();
    const callbacks = makeCallbacks({ invokeGroupMessages: [] });

    const input = { messageId: "msg-1", otterId: "otter-1", conversationId: "conv-1", senderId: "user-1", userMessageContent: "test", retryCount: 0, manualRetry: false };
    await pvt(orchestrator).completeInvokeGroupSpeakMessages(input, 5000, callbacks);

    expect(callbacks._completedSpeakIds).toHaveLength(0);
    expect(callbacks._events.filter(e => e.event === "message.complete")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────
// terminateInvokeGroupSpeakMessages
// ─────────────────────────────────────────────────
describe("terminateInvokeGroupSpeakMessages", () => {
  it("fail 路径：标记所有 speaking 状态的 speak message 为 failed", async () => {
    const orchestrator = makeOrchestrator();
    const callbacks = makeCallbacks({
      invokeGroupMessages: [
        { id: "msg-1", status: "speaking", segments: [], metadata: { invokeGroupId: "msg-1" } },
        { id: "speak-1", status: "speaking", segments: [], turnId: "turn-1", metadata: { invokeGroupId: "msg-1" } },
      ],
    });

    await pvt(orchestrator).terminateInvokeGroupSpeakMessages(
      "conv-1", "msg-1", callbacks, "failed", "[错误] test error",
    );

    expect(callbacks._failedIds).toContain("speak-1");
    // 首个 message 不被 fail（由 failTerminal 处理）
    expect(callbacks._failedIds).not.toContain("msg-1");
  });

  it("abort 路径：标记所有 speaking 状态的 speak message 为 aborted", async () => {
    const orchestrator = makeOrchestrator();
    const callbacks = makeCallbacks({
      invokeGroupMessages: [
        { id: "msg-1", status: "speaking", segments: [], metadata: { invokeGroupId: "msg-1" } },
        { id: "speak-1", status: "speaking", segments: [], turnId: "turn-1", metadata: { invokeGroupId: "msg-1" } },
      ],
    });

    await pvt(orchestrator).terminateInvokeGroupSpeakMessages(
      "conv-1", "msg-1", callbacks, "aborted", "[中断]",
    );

    expect(callbacks._abortedIds).toContain("speak-1");
  });

  it("跳过已完成/已失败/已中止的 speak message", async () => {
    const orchestrator = makeOrchestrator();
    const callbacks = makeCallbacks({
      invokeGroupMessages: [
        { id: "msg-1", status: "speaking", segments: [], metadata: { invokeGroupId: "msg-1" } },
        { id: "speak-done", status: "completed", segments: [], metadata: { invokeGroupId: "msg-1" } },
        { id: "speak-failed", status: "failed", segments: [], metadata: { invokeGroupId: "msg-1" } },
        { id: "speak-aborted", status: "aborted", segments: [], metadata: { invokeGroupId: "msg-1" } },
        { id: "speak-open", status: "speaking", segments: [], metadata: { invokeGroupId: "msg-1" } },
      ],
    });

    await pvt(orchestrator).terminateInvokeGroupSpeakMessages(
      "conv-1", "msg-1", callbacks, "failed", "[错误]",
    );

    // 只有 speaking 状态的被 fail
    expect(callbacks._failedIds).toEqual(["speak-open"]);
  });

  it("AT-7 resume 锁定：中断时打开的 speak message 可被终态化（无悬挂 streaming）", async () => {
    const orchestrator = makeOrchestrator();
    const callbacks = makeCallbacks({
      invokeGroupMessages: [
        { id: "msg-1", status: "streaming", segments: [], metadata: { invokeGroupId: "msg-1" } }, // 首 message 未 yield
        { id: "speak-1", status: "speaking", segments: [], turnId: "turn-1", metadata: { invokeGroupId: "msg-1" } }, // 中断时打开的 speak message
      ],
    });

    // resume 后 failTerminal 终态化 invoke group
    await pvt(orchestrator).terminateInvokeGroupSpeakMessages(
      "conv-1", "msg-1", callbacks, "failed", "[系统] 中断恢复",
    );

    // speak message 被终态化
    expect(callbacks._failedIds).toContain("speak-1");
    // 首个 message 由 failTerminal 的主路径处理（不在本方法范围）
  });

  it("个别 speak message 终态化失败不影响其他 message", async () => {
    const orchestrator = makeOrchestrator();
    let failAttempted = false;
    const callbacks = makeCallbacks({
      invokeGroupMessages: [
        { id: "msg-1", status: "speaking", segments: [], metadata: { invokeGroupId: "msg-1" } },
        { id: "speak-1", status: "speaking", segments: [], metadata: { invokeGroupId: "msg-1" } },
        { id: "speak-2", status: "speaking", segments: [], metadata: { invokeGroupId: "msg-1" } },
      ],
    });
    // 让第一次 fail 失败
    const origFail = callbacks.failMessage.bind(callbacks);
    callbacks.failMessage = async (id: string, body?: string) => {
      if (id === "speak-1") { failAttempted = true; throw new Error("db error"); }
      return origFail(id, body);
    };

    await pvt(orchestrator).terminateInvokeGroupSpeakMessages(
      "conv-1", "msg-1", callbacks, "failed", "[错误]",
    );

    // speak-1 失败但 speak-2 仍然被处理
    expect(failAttempted).toBe(true);
    expect(callbacks._failedIds).toContain("speak-2");
  });
});

// ─────────────────────────────────────────────────
// getInvokeGroupSpeakMessages
// ─────────────────────────────────────────────────
describe("getInvokeGroupSpeakMessages", () => {
  it("返回 invoke group 中除首个 message 外的所有消息", async () => {
    const orchestrator = makeOrchestrator();
    const callbacks = makeCallbacks({
      invokeGroupMessages: [
        { id: "msg-1", status: "speaking", segments: [], metadata: { invokeGroupId: "msg-1" } },
        { id: "speak-1", status: "speaking", segments: [], metadata: { invokeGroupId: "msg-1" } },
        { id: "speak-2", status: "completed", segments: [], metadata: { invokeGroupId: "msg-1" } },
      ],
    });

    const result = await pvt(orchestrator).getInvokeGroupSpeakMessages(
      "conv-1", "msg-1", callbacks,
    );

    expect(result).toHaveLength(2);
    expect(result.map((m: { id: string }) => m.id)).toEqual(["speak-1", "speak-2"]);
    // 不包含首个 message
    expect(result.find((m: { id: string }) => m.id === "msg-1")).toBeUndefined();
  });

  it("invokeGroupId 不存在时返回空数组", async () => {
    const orchestrator = makeOrchestrator();
    const callbacks = makeCallbacks({ invokeGroupMessages: [] });

    const result = await pvt(orchestrator).getInvokeGroupSpeakMessages(
      "conv-1", "msg-1", callbacks,
    );

    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────
// skipSegmentValidation 修复锁定
// ─────────────────────────────────────────────────
describe("skipSegmentValidation 修复锁定", () => {
  it("completeMessage 被调用时携带 skipSegmentValidation: true（首个 message 无 segment）", async () => {
    const orchestrator = makeOrchestrator();
    let completeInput: Record<string, unknown> | undefined;
    const callbacks = makeCallbacks({
      invokeGroupMessages: [
        { id: "msg-1", status: "speaking", segments: [], metadata: { invokeGroupId: "msg-1" } },
      ],
    });
    const origComplete = callbacks.completeMessage.bind(callbacks);
    callbacks.completeMessage = async (id: string, input?: Record<string, unknown>) => {
      if (id === "msg-1") completeInput = input;
      return origComplete(id, input as Parameters<typeof origComplete>[1]);
    };

    // 通过 tryCompleteSpeaking 间接测试
    await pvt(orchestrator).tryCompleteSpeaking(
      { messageId: "msg-1", otterId: "otter-1", conversationId: "conv-1", senderId: "user-1", userMessageContent: "test", retryCount: 0, manualRetry: false },
      { ctxTokens: 100, ctxMax: 200 },
      { isUserAborted: () => false, getToolCallCount: () => 0, getInternalAbortReason: () => null },
      { callbacks, startTime: Date.now(), attemptStartTime: Date.now() },
    );

    // completeMessage 应被调用且含 skipSegmentValidation: true
    expect(completeInput).toBeDefined();
    expect(completeInput!.skipSegmentValidation).toBe(true);
  });
});
