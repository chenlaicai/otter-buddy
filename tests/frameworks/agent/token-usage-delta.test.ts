import { describe, expect, it, vi } from "vitest";
import { buildInvokeResult, buildResult } from "@frameworks/agent/circuit-breaker-helpers";

function params(before?: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
  return {
    otterId: "otter-1",
    session: {
      getSessionStats: () => ({ tokens: { input: 150, output: 25, cacheRead: 60, cacheWrite: 5 } }),
      sessionManager: { getBranch: () => [] },
    },
    circuitBreaker: { getMetadata: () => ({ totalCalls: 0 }) },
    modelPool: undefined,
    otterConfigProvider: { getConfig: vi.fn() },
    model: { contextWindow: 100_000 },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getModelAliasForLog: () => "test-model",
    tokenUsageBefore: before,
  } as never;
}

describe("F20261026ctbg invoke token 透传", () => {
  it("buildResult 不再丢 cacheRead/cacheWrite（#1149 返回端遗漏）", () => {
    expect(buildResult("", { input: 10, output: 2, cacheRead: 8, cacheWrite: 1 }).tokenUsage)
      .toEqual({ input: 10, output: 2, cacheRead: 8, cacheWrite: 1 });
  });

  it("buildInvokeResult 同时保留 session 快照与本次 invoke 四分量增量", () => {
    const result = buildInvokeResult(params({ input: 100, output: 20, cacheRead: 40, cacheWrite: 2 }));
    expect(result.tokenUsage).toEqual({ input: 150, output: 25, cacheRead: 60, cacheWrite: 5 });
    expect(result.tokenUsageDelta).toEqual({ input: 50, output: 5, cacheRead: 20, cacheWrite: 3 });
  });
});
