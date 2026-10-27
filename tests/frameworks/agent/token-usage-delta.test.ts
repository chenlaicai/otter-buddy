import { describe, expect, it, vi } from "vitest";
import { buildInvokeResult, buildResult } from "@frameworks/agent/circuit-breaker-helpers";
import { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";

vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

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
  it("prompt 已消耗后抛错，异常仍携带本次四分量差分", async () => {
    const db = createTestDb();
    const factory = new PiSessionFactory({
      db, sessionDir: ":memory:", otterToolClient: {} as never, model: null as never, createTools: () => [],
      otterConfigProvider: { getConfig: () => ({ systemPrompt: undefined, otterType: "big", modelAlias: null }), setConfig: () => {}, deleteConfig: () => {} } as never,
      otterRepo: new SqliteOtterRepository(db),
    }, createTestLogger());
    const internals = factory as unknown as {
      activeSessions: Map<string, { abort: () => Promise<void>; toolCallCount: number }>;
      identityBuilder: { buildIdentityPrefix: () => Promise<string>; getOtterName: () => Promise<string> };
      _executeWithSession: (...args: unknown[]) => Promise<unknown>;
    };
    internals.activeSessions.set("otter-1:invoke-1", { abort: async () => {}, toolCallCount: 0 });
    let tokens = { input: 100, output: 20, cacheRead: 40, cacheWrite: 2 };
    const session = {
      subscribe: () => () => {},
      prompt: async () => { tokens = { input: 150, output: 25, cacheRead: 60, cacheWrite: 5 }; throw new Error("prompt rejected after billable work"); },
      abort: async () => {}, getSessionStats: () => ({ tokens }), sessionManager: { getBranch: () => [] }, state: {},
    };
    const error = await internals._executeWithSession("otter-1", "work", undefined, session, "otter-1:invoke-1", {}, { text: "" })
      .catch((e: unknown) => e as Error & { _tokenUsageDelta?: unknown });
    expect(error).toBeInstanceOf(Error);
    expect((error as { _tokenUsageDelta?: unknown })._tokenUsageDelta).toEqual({ input: 50, output: 5, cacheRead: 20, cacheWrite: 3 });
    db.close();
  });
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
