/**
 * F20260916fst4：orchestrator 首哑判定（first-dumb）单测。
 *
 * 覆盖方案验证段 5 用例：
 * - 首次 invoke + exhausted 命中挂 _firstDumb
 * - count>1（非首次）不挂
 * - 瞬时 429（exhausted=false）不挂
 * - type!=='small'（大獭）不挂
 * - matchRateLimitError 解析失败（match=null）不挂
 *
 * 判定路径：executeTurn → classifyExit(api_error) → handleApiError → detectFirstDumb → failTerminal。
 * 全部走 AgentTurnOrchestrator 公开接口（executeTurn），TurnCallbacks 用最小内存 mock。
 */

import { describe, it, expect } from "vitest";
import { AgentTurnOrchestrator } from "@usecases/conversation/agent-turn-orchestrator/orchestrator";
import type { TurnInput, TurnCallbacks, AttemptDriver, TurnResult } from "@usecases/conversation/agent-turn-orchestrator/types";
import { createTestLogger } from "../../../helpers/logger";

/** 配额耗尽 429 错误消息（matchRateLimitError 命中 exhausted=true） */
const EXHAUSTED_429 = 'LLM API error: 429 {"code":"1310","message":"code: 1310, 本月配额已耗尽，将于 2026-09-20 08:00 重置"}';
/** 瞬时 429（matchRateLimitError 命中 exhausted=false） */
const TRANSIENT_429 = "LLM API error: 429 Too Many Requests";
/** 非限流 API 错误（matchRateLimitError 返回 null） */
const NON_RATE_LIMIT = "LLM API error: 500 Internal Server Error";

function makeInput(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    otterId: "otter-small-1",
    conversationId: "conv-1",
    invokeId: "invoke-1",
    userMessageContent: "干活去",
    originalUserMessage: "请审视这份代码",
    senderId: "user-1",
    retryCount: 0,
    manualRetry: false,
    attemptStartTime: Date.now(),
    ...overrides,
  };
}

/** 让 driver.invoke 抛出 api_error 的 AttemptDriver */
function makeErrorDriver(error: Error): AttemptDriver {
  return {
    invoke: async () => { throw error; },
    abort: () => {},
    getInternalAbortReason: () => undefined,
    getToolCallCount: () => 0,
    isUserAborted: () => false,
  };
}

/** 最小 TurnCallbacks mock：可注入 invokeCount / otterType */
function makeCallbacks(opts: {
  invokeCount?: number;
  otterType?: string;
}): TurnCallbacks & { systemBodies: string[]; healingEvents: unknown[] } {
  const systemBodies: string[] = [];
  const healingEvents: unknown[] = [];
  const noop = async () => undefined;
  return {
    getInvokeById: async () => ({ status: "running", toolCallCount: 0 }),
    updateInvokeStatus: noop,
    createInvokeEndEntry: async () => ({ entryId: "e1", body: "body" }),
    emitInvokeEnd: () => {},
    recordHealingEvent: async (input: unknown) => { healingEvents.push(input); },
    getRecentGuardBounces: async () => 0,
    isSessionCircuitBreakCreated: async () => false,
    isCircuitBreakerEnabled: () => false,
    sendSystem: async (_convId: string, body: string) => { systemBodies.push(body); return { id: "s1", body, sequenceNum: 1, createdAt: "2026-09-21T00:00:00Z" }; },
    getOtterById: async () => (opts.otterType === undefined ? null : { name: "獭", type: opts.otterType }),
    getPartnerLabel: async () => "搭档",
    emitEvent: () => {},
    getInvokeCount: async () => opts.invokeCount ?? 1,
    logger: createTestLogger(),
    systemBodies,
    healingEvents,
  } as TurnCallbacks & { systemBodies: string[]; healingEvents: unknown[] };
}

/** api_error 需要 classifyExit 可分类的错误形态——Error 即可（非 abort 即 api_error） */
function apiError(message: string): Error {
  return new Error(message);
}

describe("F20260916fst4 orchestrator 首哑判定", () => {
  it("首次 invoke + exhausted 429 → TurnResult 挂 _firstDumb（含模型/任务/错误摘要）", async () => {
    const orch = new AgentTurnOrchestrator(createTestLogger());
    const callbacks = makeCallbacks({ invokeCount: 1, otterType: "small" });
    const input = makeInput();

    const result: TurnResult = await orch.executeTurn(input, makeErrorDriver(apiError(EXHAUSTED_429)), callbacks);

    expect(result.invokeId).toBe("invoke-1");
    expect(result._firstDumb).toBeTruthy();
    expect(result._firstDumb!.otterId).toBe("otter-small-1");
    expect(result._firstDumb!.conversationId).toBe("conv-1");
    expect(result._firstDumb!.modelAlias).toBe("unknown"); // 无 modelAlias 时回退
    expect(result._firstDumb!.originalUserMessage).toBe("请审视这份代码");
    expect(result._firstDumb!.errorMessage).toContain("1310");
    expect(result._firstDumb!.resetHint).toBeTruthy();
    expect(result._firstDumb!.failedInvokeId).toBe("invoke-1");
    // healing 落账已发生（#543 通道不被首哑阻断）
    expect(callbacks.healingEvents.length).toBeGreaterThan(0);
  });

  it("count>1（非首次 invoke）→ 不挂 _firstDumb（运行中 429 维持现状）", async () => {
    const orch = new AgentTurnOrchestrator(createTestLogger());
    const callbacks = makeCallbacks({ invokeCount: 2, otterType: "small" });

    const result = await orch.executeTurn(makeInput(), makeErrorDriver(apiError(EXHAUSTED_429)), callbacks);

    expect(result._firstDumb).toBeUndefined();
  });

  it("瞬时 429（exhausted=false）→ 不挂 _firstDumb", async () => {
    const orch = new AgentTurnOrchestrator(createTestLogger());
    const callbacks = makeCallbacks({ invokeCount: 1, otterType: "small" });

    const result = await orch.executeTurn(makeInput(), makeErrorDriver(apiError(TRANSIENT_429)), callbacks);

    expect(result._firstDumb).toBeUndefined();
  });

  it("type!=='small'（大獭自身 429）→ 不挂 _firstDumb", async () => {
    const orch = new AgentTurnOrchestrator(createTestLogger());
    const callbacks = makeCallbacks({ invokeCount: 1, otterType: "big" });

    const result = await orch.executeTurn(makeInput(), makeErrorDriver(apiError(EXHAUSTED_429)), callbacks);

    expect(result._firstDumb).toBeUndefined();
  });

  it("matchRateLimitError 解析失败（非限流 API 错误，match=null）→ 不挂 _firstDumb", async () => {
    const orch = new AgentTurnOrchestrator(createTestLogger());
    const callbacks = makeCallbacks({ invokeCount: 1, otterType: "small" });

    const result = await orch.executeTurn(makeInput(), makeErrorDriver(apiError(NON_RATE_LIMIT)), callbacks);

    expect(result._firstDumb).toBeUndefined();
  });
});
