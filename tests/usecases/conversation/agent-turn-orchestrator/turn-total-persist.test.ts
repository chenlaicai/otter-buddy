import { describe, expect, it } from "vitest";
import { AgentTurnOrchestrator } from "@usecases/conversation/agent-turn-orchestrator/orchestrator";
import type { TurnInput, TurnCallbacks, AttemptDriver } from "@usecases/conversation/agent-turn-orchestrator/types";
import { createTestLogger } from "../../../helpers/logger";

function input(): TurnInput {
  return { otterId: "otter-1", conversationId: "conv-1", invokeId: "invoke-1", userMessageContent: "work", originalUserMessage: "work", senderId: "user", retryCount: 0, manualRetry: false, attemptStartTime: Date.now() };
}

/** 落库口径：invokes 四列 = 整 turn 聚合（预算/账本唯一口径），不是末次 attempt 终态快照。 */
describe("turn accounting persist", () => {
  it("两 attempt turn 成功后 updateInvokeTokenUsage 收到总和，而非末次 attempt 快照", async () => {
    let attempts = 0;
    const writes: Array<{ input: number; output: number; cacheRead?: number; cacheWrite?: number }> = [];
    const cb = {
      getInvokeById: async () => ({ status: attempts >= 2 ? "completed" : "running", toolCallCount: 0 }),
      updateInvokeStatus: async () => undefined,
      createInvokeEndEntry: async () => ({ entryId: "end-1", body: "done" }),
      emitInvokeEnd: () => {},
      updateInvokeTokenUsage: async (_id: string, i: number, o: number, cr?: number, cw?: number) => { writes.push({ input: i, output: o, cacheRead: cr, cacheWrite: cw }); },
      recordHealingEvent: async () => undefined,
      getRecentGuardBounces: async () => 0,
      isSessionCircuitBreakCreated: async () => false,
      isCircuitBreakerEnabled: () => false,
      sendSystem: async () => ({ id: "sys-1", body: "done", sequenceNum: 1, createdAt: "2026-11-25T00:00:00Z" }),
      getOtterById: async () => null,
      getPartnerLabel: async () => "搭档",
      emitEvent: () => {},
      getInvokeCount: async () => 1,
      logger: createTestLogger(),
    } as unknown as TurnCallbacks;
    const driver: AttemptDriver = {
      invoke: async () => {
        attempts++;
        if (attempts === 1) return { result: { text: "", tokenUsageDelta: { input: 40, output: 4, cacheRead: 8, cacheWrite: 2 } }, toolCallCount: 0 };
        return { result: { text: "done", tokenUsage: { input: 5, output: 1 }, tokenUsageDelta: { input: 5, output: 1 } }, toolCallCount: 0 };
      },
      abort: () => {}, getInternalAbortReason: () => undefined, isUserAborted: () => false,
    } as AttemptDriver;
    const result = await new AgentTurnOrchestrator(createTestLogger()).executeTurn(input(), driver, cb);
    expect(attempts).toBe(2);
    expect(result.tokenUsageDelta).toMatchObject({ input: 45, output: 5, cacheRead: 8, cacheWrite: 2 });
    // 落库一次，且是整 turn 总和——不是末次 attempt 快照 {input:5,output:1}
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ input: 45, output: 5, cacheRead: 8, cacheWrite: 2 });
  });

  it("成功单 attempt：落库等于该 attempt 增量；delta 缺失（telemetry 缺口）不落库不伪造", async () => {
    const writes: Array<{ input: number; output: number }> = [];
    const cb = {
      getInvokeById: async () => ({ status: "completed", toolCallCount: 0 }),
      updateInvokeStatus: async () => undefined,
      createInvokeEndEntry: async () => ({ entryId: "end-1", body: "done" }),
      emitInvokeEnd: () => {},
      updateInvokeTokenUsage: async (_id: string, i: number, o: number) => { writes.push({ input: i, output: o }); },
      recordHealingEvent: async () => undefined,
      getRecentGuardBounces: async () => 0,
      isSessionCircuitBreakCreated: async () => false,
      isCircuitBreakerEnabled: () => false,
      sendSystem: async () => ({ id: "sys-1", body: "done", sequenceNum: 1, createdAt: "2026-11-25T00:00:00Z" }),
      getOtterById: async () => null,
      getPartnerLabel: async () => "搭档",
      emitEvent: () => {},
      getInvokeCount: async () => 1,
      logger: createTestLogger(),
    } as unknown as TurnCallbacks;
    const ok: AttemptDriver = {
      invoke: async () => ({ result: { text: "done", tokenUsage: { input: 50, output: 5 }, tokenUsageDelta: { input: 50, output: 5 } }, toolCallCount: 0 }),
      abort: () => {}, getInternalAbortReason: () => undefined, isUserAborted: () => false,
    } as AttemptDriver;
    await new AgentTurnOrchestrator(createTestLogger()).executeTurn(input(), ok, cb);
    expect(writes).toEqual([{ input: 50, output: 5 }]);

    writes.length = 0;
    const gap: AttemptDriver = {
      invoke: async () => ({ result: { text: "done", tokenUsage: { input: 50, output: 5 } }, toolCallCount: 0 }),
      abort: () => {}, getInternalAbortReason: () => undefined, isUserAborted: () => false,
    } as AttemptDriver;
    await new AgentTurnOrchestrator(createTestLogger()).executeTurn(input(), gap, cb);
    // delta 缺失：不落库（四列留 null，账本 usageGap 显式计出），不用末次快照伪造总量
    expect(writes).toHaveLength(0);
  });
});
