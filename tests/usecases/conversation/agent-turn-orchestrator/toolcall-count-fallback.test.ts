/**
 * #1116：orchestrator 兜底死链 + getToolCallCount Map 重查竞态——终态计数语义锁。
 *
 * bug 形态（两半）：
 * 1. factory catch（#763 修复后）恒写 number _toolCallCount → orchestrator
 *    `?? driver.getToolCallCount(...)` 右半对经 factory 的错误永不触发（死链）。
 * 2. 错误亦可从 _acquirePooled 阶段抛出（嵌套撞 streaming / config not found /
 *    lock timeout）——此时尚未 attachGuards、无任何工具调用，本 invoke 计数必为 0；
 *    旧兜底走 Map 重查会落到裸 otterId 键，读到同 otter 其他活跃 invoke 的计数
 *    （嵌套场景恰是活跃条目在场场景）——跨 invoke 污染，比 0 更糟。
 *
 * 修复：`errMeta._toolCallCount ?? 0`——无快照 = attachGuards 前抛错 = 零次工具调用。
 * 全链退役 getToolCallCount（AttemptDriver / SdkInvokePort / factory 实现）。
 *
 * 场景 1 红测现场：driver.getToolCallCount 返回 7（模拟读到别的 invoke 的计数），
 * 修复前终态载荷与文案带 7（污染实锤），修复后必须为 0。
 */

import { describe, it, expect } from "vitest";
import { AgentTurnOrchestrator } from "@usecases/conversation/agent-turn-orchestrator/orchestrator";
import type { TurnInput, TurnCallbacks, AttemptDriver } from "@usecases/conversation/agent-turn-orchestrator/types";
import { createTestLogger } from "../../../helpers/logger";

function makeInput(): TurnInput {
  return {
    otterId: "otter-1116",
    conversationId: "conv-1",
    invokeId: "invoke-1116",
    userMessageContent: "干活去",
    originalUserMessage: "请处理这个任务",
    senderId: "user-1",
    retryCount: 0,
    manualRetry: false,
    attemptStartTime: Date.now(),
  };
}

interface Captured {
  endBodies: string[];
  invokeEnds: Array<{ status: string; toolCallCount?: number }>;
}

function makeCallbacks(): TurnCallbacks & Captured {
  const endBodies: string[] = [];
  const invokeEnds: Captured["invokeEnds"] = [];
  const noop = async () => undefined;
  return {
    getInvokeById: async () => ({ status: "running", toolCallCount: 0 }),
    updateInvokeStatus: noop,
    createInvokeEndEntry: async (_id: string, _status: string, body: string) => {
      endBodies.push(body);
      return { entryId: "e1", body };
    },
    emitInvokeEnd: (_id: string, status: string, _dur: number, data: { toolCallCount?: number }) => {
      invokeEnds.push({ status, toolCallCount: data.toolCallCount });
    },
    recordHealingEvent: noop,
    getRecentGuardBounces: async () => 0,
    isSessionCircuitBreakCreated: async () => false,
    isCircuitBreakerEnabled: () => false,
    sendSystem: async (_c: string, body: string) => ({ id: "s1", body, sequenceNum: 1, createdAt: "2026-11-01T00:00:00Z" }),
    getOtterById: async () => ({ name: "小獭", type: "small" }),
    getPartnerLabel: async () => "搭档",
    emitEvent: () => {},
    getInvokeCount: async () => 3,
    logger: createTestLogger(),
    endBodies,
    invokeEnds,
  } as unknown as TurnCallbacks & Captured;
}

describe("#1116 err 路径 toolCallCount 兜底语义（无快照=0，快照优先）", () => {
  it("无 _toolCallCount（acquire 阶段抛错形态）→ 终态计数 0，不被 Map 重查污染为 7", async () => {
    const orchestrator = new AgentTurnOrchestrator(createTestLogger(), undefined);
    const callbacks = makeCallbacks();
    // acquire 阶段抛错：无 _toolCallCount 字段（未经过 factory catch）；
    // 旧兜底 getToolCallCount 会 Map 重查读到别的 invoke 的 7（跨 invoke 污染现场）
    const err = Object.assign(new Error("nested invoke while outer invoke is streaming"), {});
    const driver = {
      invoke: async () => { throw err; },
      abort: () => {},
      getInternalAbortReason: () => undefined,
      getToolCallCount: () => 7,
      isUserAborted: () => true,
      getRetryErrorMessage: () => undefined,
    } as unknown as AttemptDriver;

    await orchestrator.executeTurn(makeInput(), driver, callbacks);

    const aborted = callbacks.invokeEnds.find(e => e.status === "aborted");
    expect(aborted?.toolCallCount).toBe(0);
    // 文案不带污染计数：0 次走纯简洁文案，不出现「经过 7 次工具调用」
    expect(callbacks.endBodies[0]).not.toContain("7 次");
    expect(callbacks.endBodies[0]).toContain("中断");
  });

  it("带 _toolCallCount: 5（factory catch 快照形态）→ 快照优先透传，终态载荷 5", async () => {
    const orchestrator = new AgentTurnOrchestrator(createTestLogger(), undefined);
    const callbacks = makeCallbacks();
    const err = Object.assign(new Error("LLM API error: Request aborted"), { _toolCallCount: 5 });
    const driver = {
      invoke: async () => { throw err; },
      abort: () => {},
      getInternalAbortReason: () => undefined,
      getToolCallCount: () => 7,
      isUserAborted: () => true,
      getRetryErrorMessage: () => undefined,
    } as unknown as AttemptDriver;

    await orchestrator.executeTurn(makeInput(), driver, callbacks);

    const aborted = callbacks.invokeEnds.find(e => e.status === "aborted");
    expect(aborted?.toolCallCount).toBe(5);
    expect(callbacks.endBodies[0]).toContain("5 次工具调用");
  });
});
