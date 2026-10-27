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
  it("已耗 token 的 rejected attempt 与后续成功 attempt 各计一次", async () => {
    let call = 0;
    const attemptDriver: AttemptDriver = {
      invoke: async () => {
        if (call++ === 0) throw Object.assign(new Error("SDK failure after usage"), { _guardAbortReason: "first_byte_timeout", _tokenUsageDelta: { input: 40, output: 4, cacheRead: 8, cacheWrite: 2 } });
        return { result: { text: "done", tokenUsageDelta: { input: 5, output: 1 } }, toolCallCount: 0 };
      },
      abort: () => {}, getInternalAbortReason: () => undefined, getToolCallCount: () => 0, isUserAborted: () => false,
    };
    const result = await new AgentTurnOrchestrator(createTestLogger()).executeTurn(input(), attemptDriver, callbacks("failed"));
    expect(call).toBe(2);
    expect(result.tokenUsageDelta).toMatchObject({ input: 45, output: 5, cacheRead: 8, cacheWrite: 2 });
  });
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

  it("user_abort 晚到（invoke 已 completed）也不丢增量：handleUserAbort 收尾路径透传 tokenUsageDelta（审视发现 3① 防回退）", async () => {
    // 现场：SDK invoke 成功返回 + driver 已标记用户 abort → tryCompleteInvoke 让路（isUserAborted 短路）
    // → classify=user_abort → handleUserAbort 查库见 completed → 按成功收尾。增量已真实消耗，
    // 且链可能续跑——漏透传则重复回路上虚假推进停滞计数（hasActivity 虚低）。
    // 实现兑点：executeTurn 对 routeByReason 返回值统一回填 routeCtx.tokenUsageDelta（orchestrator.ts:151-152）。
    const abortDriver = driver([{ input: 50, output: 5 }]);
    (abortDriver as unknown as { isUserAborted: () => boolean }).isUserAborted = () => true;
    const result = await new AgentTurnOrchestrator(createTestLogger()).executeTurn(input(), abortDriver, callbacks());
    expect(result.tokenUsageDelta).toMatchObject({ input: 50, output: 5 });
  });
});
