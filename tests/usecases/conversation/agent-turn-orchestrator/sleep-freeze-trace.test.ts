/**
 * F20261111slfrz：睡眠冻结痕迹落账行为测试（检视 P2 补覆盖）。
 *
 * 走真实 executeTurn（backoff-abort-attribution 同模式）：invoke 抛
 * guard abort（_guardAbortReason + _outputGuardMetadata 冻结痕迹）→ 断言
 * ①冻结超时落 healing（sleep_freeze/low）+ 系统提醒附空窗说明（中性文案，
 * 不宣称「已恢复」）；②重试耗尽路径 healing 仍落且终态文案不含恢复断言；
 * ③非冻结（suspectedFreeze=false）/无 metadata 的超时不落 sleep_freeze。
 */
import { describe, it, expect } from "vitest";
import { AgentTurnOrchestrator } from "@usecases/conversation/agent-turn-orchestrator/orchestrator";
import type { TurnInput, TurnCallbacks, AttemptDriver, HealingEventInput } from "@usecases/conversation/agent-turn-orchestrator/types";
import { createTestLogger } from "../../../helpers/logger";

function makeInput(retryCount = 0): TurnInput {
  return {
    otterId: "otter-slfrz",
    conversationId: "conv-slfrz",
    invokeId: "invoke-slfrz",
    userMessageContent: "干活去",
    originalUserMessage: "请继续",
    senderId: "user-1",
    retryCount,
    manualRetry: false,
    attemptStartTime: Date.now(),
  };
}

/** 冻结超时 guard abort 现场：err 带 _guardAbortReason + _outputGuardMetadata（51min/300s 实证形态） */
function freezeAbortError(opts: { elapsedMs: number; suspectedFreeze: boolean; withMeta: boolean }): Error {
  const err = new Error("LLM API error: Request aborted");
  (err as Error & { _guardAbortReason?: string })._guardAbortReason = "first_byte_timeout";
  if (opts.withMeta) {
    (err as Error & { _outputGuardMetadata?: { timeoutElapsedMs?: number; suspectedFreeze?: boolean } })._outputGuardMetadata
      = { timeoutElapsedMs: opts.elapsedMs, suspectedFreeze: opts.suspectedFreeze };
  }
  return err;
}

function makeHarness(errFactory: () => Error) {
  const healingEvents: HealingEventInput[] = [];
  const systemBodies: string[] = [];
  const endBodies: string[] = [];
  let call = 0;
  const driver: AttemptDriver = {
    invoke: async () => { call += 1; throw errFactory(); },
    abort: () => {},
    getInternalAbortReason: () => undefined,
    isUserAborted: () => false,
    getRetryErrorMessage: () => undefined,
  };
  const noop = async () => undefined;
  const callbacks = {
    getInvokeById: async () => ({ status: "running", toolCallCount: 3 }),
    updateInvokeStatus: noop,
    createInvokeEndEntry: async (_id: string, _status: string, body: string) => {
      endBodies.push(body);
      return { entryId: "e1", body };
    },
    emitInvokeEnd: () => {},
    recordHealingEvent: async (input: HealingEventInput) => { healingEvents.push(input); },
    getRecentGuardBounces: async () => 0,
    isSessionCircuitBreakCreated: async () => false,
    isCircuitBreakerEnabled: () => false,
    sendSystem: async (_c: string, body: string) => { systemBodies.push(body); return { id: "s1", body, sequenceNum: 1, createdAt: "2026-11-11T00:00:00Z" }; },
    getOtterById: async () => ({ name: "小獭", type: "small" }),
    getPartnerLabel: async () => "搭档",
    emitEvent: () => {},
    getInvokeCount: async () => 1,
    logger: createTestLogger(),
  } as unknown as TurnCallbacks;
  return { driver, callbacks, healingEvents, systemBodies, endBodies, invokeCalls: () => call };
}

describe("F20261111slfrz 睡眠冻结痕迹落账（routeGuardAbort 行为）", () => {
  it("冻结超时（51min/300s 实证形态）：落 sleep_freeze healing + 系统提醒附空窗（中性文案，不宣称已恢复）", async () => {
    const orchestrator = new AgentTurnOrchestrator(createTestLogger(), undefined);
    const h = makeHarness(() => freezeAbortError({ elapsedMs: 51 * 60_000, suspectedFreeze: true, withMeta: true }));
    await orchestrator.executeTurn(makeInput(), h.driver, h.callbacks);

    const freezeEvents = h.healingEvents.filter((e) => e.errorType === "sleep_freeze");
    expect(freezeEvents.length).toBeGreaterThan(0);
    expect(freezeEvents[0].severity).toBe("low");
    expect(freezeEvents[0].description).toContain("51");
    expect(freezeEvents[0].description).not.toContain("已自动恢复");
    expect(freezeEvents[0].description).toContain("超时熔断接管");

    const freezeNotice = h.systemBodies.find((b) => b.includes("疑似系统睡眠冻结"));
    expect(freezeNotice).toBeDefined();
    expect(freezeNotice).toContain("51 分钟");
    expect(freezeNotice).not.toContain("已自动恢复");
  });

  it("重试后再冻结（耗尽路径）：每次触发都落 healing，终态文案不含恢复断言", async () => {
    const orchestrator = new AgentTurnOrchestrator(createTestLogger(), undefined);
    const h = makeHarness(() => freezeAbortError({ elapsedMs: 109 * 60_000, suspectedFreeze: true, withMeta: true }));
    await orchestrator.executeTurn(makeInput(), h.driver, h.callbacks);

    // 首次触发落 healing；重试后第二次触发也落（每次 guard fire 都留痕）
    expect(h.healingEvents.filter((e) => e.errorType === "sleep_freeze").length).toBe(2);
    expect(h.invokeCalls()).toBe(2); // 首次 + 自动重试各一次
    const terminalBody = h.endBodies.join("\n");
    expect(terminalBody).not.toContain("已自动恢复");
  });

  it("非冻结超时（elapsed 未超 2×budget）：不落 sleep_freeze", async () => {
    const orchestrator = new AgentTurnOrchestrator(createTestLogger(), undefined);
    const h = makeHarness(() => freezeAbortError({ elapsedMs: 400_000, suspectedFreeze: false, withMeta: true }));
    await orchestrator.executeTurn(makeInput(), h.driver, h.callbacks);
    expect(h.healingEvents.filter((e) => e.errorType === "sleep_freeze")).toHaveLength(0);
    expect(h.systemBodies.some((b) => b.includes("疑似系统睡眠冻结"))).toBe(false);
  });

  it("超时 guard 无 metadata（旧链路/非 Error err）：不落 sleep_freeze、不误报", async () => {
    const orchestrator = new AgentTurnOrchestrator(createTestLogger(), undefined);
    const h = makeHarness(() => freezeAbortError({ elapsedMs: 0, suspectedFreeze: false, withMeta: false }));
    await orchestrator.executeTurn(makeInput(), h.driver, h.callbacks);
    expect(h.healingEvents.filter((e) => e.errorType === "sleep_freeze")).toHaveLength(0);
  });
});
