/**
 * #764：429 backoff 期间 abort 的归因盲区修复——orchestrator 集成测试。
 *
 * bug 形态：用户在 SDK retry backoff 睡眠期间点 abort → retry 层抹 errorMessage
 * （{...rest, stopReason:"aborted"}）→ err 通道拿不到底层错误 → underlyingError
 * undefined → 「因限流未能开始」归因文案主路径不可达。
 *
 * 修复：auto_retry_start 事件带完整 errorMessage → agent-invoker 观测窗 →
 * driver.getRetryErrorMessage → orchestrator 在 user_abort 且无 underlyingError 时
 * 回填 api_error 归因。
 *
 * 本测试走真实 executeTurn：driver.isUserAborted()=true + invoke 抛 abort 自身产物
 * （err 通道无底层错误）+ getRetryErrorMessage 返回 429 原文 → 断言 abort 文案带
 * 「底层错误」归因（修复前：归因缺失走「纯主动中断」简洁文案）。
 */

import { describe, it, expect } from "vitest";
import { AgentTurnOrchestrator } from "@usecases/conversation/agent-turn-orchestrator/orchestrator";
import type { TurnInput, TurnCallbacks, AttemptDriver } from "@usecases/conversation/agent-turn-orchestrator/types";
import { createTestLogger } from "../../../helpers/logger";

/** SDK abort 自身产物（pi-ai 生产现场形态：无 was 变体） */
const ABORT_OWN = new Error("LLM API error: Request aborted");
/** backoff 期间等待的底层错误（auto_retry_start.errorMessage 原文形态） */
const RETRY_429 = 'LLM API error: 429 {"code":"1302","message":"rate limit exceeded"}';

function makeInput(): TurnInput {
  return {
    otterId: "otter-764",
    conversationId: "conv-1",
    invokeId: "invoke-764",
    userMessageContent: "干活去",
    originalUserMessage: "请审视这份代码",
    senderId: "user-1",
    retryCount: 0,
    manualRetry: false,
    attemptStartTime: Date.now(),
  };
}

/** backoff-abort 现场 driver：用户已 abort + err 是 abort 自身产物 + retry 观测窗有 429 原文 */
function makeBackoffAbortDriver(retryError: string | undefined): AttemptDriver {
  return {
    invoke: async () => { throw ABORT_OWN; },
    abort: () => {},
    getInternalAbortReason: () => undefined,
    getToolCallCount: () => 0,
    isUserAborted: () => true,
    getRetryErrorMessage: () => retryError,
  };
}

function makeCallbacks(): TurnCallbacks & { endBodies: string[] } {
  const endBodies: string[] = [];
  const noop = async () => undefined;
  return {
    getInvokeById: async () => ({ status: "running", toolCallCount: 0 }),
    updateInvokeStatus: noop,
    createInvokeEndEntry: async (_id: string, _status: string, body: string) => {
      endBodies.push(body);
      return { entryId: "e1", body };
    },
    emitInvokeEnd: () => {},
    recordHealingEvent: noop,
    getRecentGuardBounces: async () => 0,
    isSessionCircuitBreakCreated: async () => false,
    isCircuitBreakerEnabled: () => false,
    sendSystem: async (_c: string, body: string) => ({ id: "s1", body, sequenceNum: 1, createdAt: "2026-09-22T00:00:00Z" }),
    getOtterById: async () => ({ name: "小獭", type: "small" }),
    getPartnerLabel: async () => "搭档",
    emitEvent: () => {},
    getInvokeCount: async () => 3,
    logger: createTestLogger(),
    endBodies,
  } as unknown as TurnCallbacks & { endBodies: string[] };
}

describe("#764 429 backoff 期间 abort 归因（retry 观测窗回填）", () => {
  it("backoff-abort 现场：retry 观测窗有 429 原文 → 归因文案带底层错误（修复前走纯中断简洁文案）", async () => {
    const orchestrator = new AgentTurnOrchestrator(createTestLogger(), undefined);
    const callbacks = makeCallbacks();
    await orchestrator.executeTurn(makeInput(), makeBackoffAbortDriver(RETRY_429), callbacks);

    expect(callbacks.endBodies.length).toBeGreaterThan(0);
    const body = callbacks.endBodies[0];
    // 归因主路径恢复可达：底层错误 + 429 原文出现在中断文案
    expect(body).toContain("底层错误");
    expect(body).toContain("429");
  });

  it("无 retry 观测窗（getRetryErrorMessage=undefined）→ 保持纯主动中断简洁文案（防误归因）", async () => {
    const orchestrator = new AgentTurnOrchestrator(createTestLogger(), undefined);
    const callbacks = makeCallbacks();
    await orchestrator.executeTurn(makeInput(), makeBackoffAbortDriver(undefined), callbacks);

    const body = callbacks.endBodies[0];
    expect(body).not.toContain("底层错误");
    expect(body).toContain("中断");
  });

  it("driver 未实现 getRetryErrorMessage（可选接口缺席）→ 不炸，按无观测窗处理", async () => {
    const orchestrator = new AgentTurnOrchestrator(createTestLogger(), undefined);
    const callbacks = makeCallbacks();
    const driver = makeBackoffAbortDriver(undefined);
    delete (driver as Partial<AttemptDriver>).getRetryErrorMessage;
    await orchestrator.executeTurn(makeInput(), driver, callbacks);

    expect(callbacks.endBodies[0]).not.toContain("底层错误");
  });
});
