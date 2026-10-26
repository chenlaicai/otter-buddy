import { describe, expect, it } from "vitest";
import { AgentTurnOrchestrator } from "@usecases/conversation/agent-turn-orchestrator/orchestrator";
import type { TurnInput, TurnCallbacks, AttemptDriver } from "@usecases/conversation/agent-turn-orchestrator/types";
import { createTestLogger } from "../../../helpers/logger";

function input(): TurnInput {
  return { otterId: "otter-1", conversationId: "conv-1", invokeId: "invoke-1", userMessageContent: "work", originalUserMessage: "work", senderId: "user", retryCount: 0, manualRetry: false, attemptStartTime: Date.now() };
}

function callbacks(status: "completed" | "failed" = "completed"): TurnCallbacks {
  const noop = async () => undefined;
  return {
    getInvokeById: async () => ({ status, toolCallCount: 0 }),
    updateInvokeStatus: noop,
    createInvokeEndEntry: async () => ({ entryId: "end-1", body: "done" }),
    emitInvokeEnd: () => {},
    recordHealingEvent: noop,
    getRecentGuardBounces: async () => 0,
    isSessionCircuitBreakCreated: async () => false,
    isCircuitBreakerEnabled: () => false,
    sendSystem: async () => ({ id: "sys-1", body: "done", sequenceNum: 1, createdAt: "2026-10-26T00:00:00Z" }),
    getOtterById: async () => null,
    getPartnerLabel: async () => "搭档",
    emitEvent: () => {},
    getInvokeCount: async () => 1,
    logger: createTestLogger(),
  } as unknown as TurnCallbacks;
}

function driver(results: Array<{ input: number; output: number }>): AttemptDriver {
  let index = 0;
  return {
    invoke: async () => {
      const tokenUsageDelta = results[index++] ?? results.at(-1);
      return { result: { text: "done", tokenUsageDelta: tokenUsageDelta && { ...tokenUsageDelta } }, toolCallCount: 0 };
    },
    abort: () => {}, getInternalAbortReason: () => undefined, getToolCallCount: () => 0, isUserAborted: () => false,
  } as AttemptDriver;
}

describe("F20261026ctbg orchestrator token 增量", () => {
  it("成功 turn 返回单次 invoke 的真实增量", async () => {
    const result = await new AgentTurnOrchestrator(createTestLogger()).executeTurn(input(), driver([{ input: 50, output: 5 }]), callbacks());
    expect(result.tokenUsageDelta).toMatchObject({ input: 50, output: 5 });
    expect(result.tokenUsageDelta?.cacheWrite).toBe(0);
  });

  it("no_yield 同 invoke 重试累加每个 attempt，而非只取最后一个", async () => {
    const result = await new AgentTurnOrchestrator(createTestLogger()).executeTurn(input(), driver([{ input: 50, output: 5 }, { input: 20, output: 2 }]), callbacks("failed"));
    expect(result.tokenUsageDelta).toMatchObject({ input: 70, output: 7 });
    expect(result.tokenUsageDelta?.cacheRead).toBe(0);
  });
});
