import { describe, expect, it, vi } from "vitest";
import { DispatchChainEngine, type ChainStop, type InvokeFnResult } from "@usecases/conversation/dispatch-chain-engine";
import type { AgentMetricsPort } from "@usecases/ports/agent-metrics-port";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import { diffTokenUsage } from "@usecases/conversation/token-usage";

const usage = (input = 1): NonNullable<InvokeFnResult["tokenUsageDelta"]> => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });

function fixture() {
  const invokes = new Map<string, { id: string; status: string; otterId: string; talkingStonePassedTo: string[]; endedAt: string }>();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const healingEvents: Array<Record<string, unknown>> = [];
  const healingRepo = { create: vi.fn(async (event: Record<string, unknown>) => { healingEvents.push(event); }) } as unknown as HealingEventRepository;
  const metricEvents: Array<Record<string, unknown>> = [];
  const metrics = {
    recordChainHops: (count: number) => metricEvents.push({ type: "hops", count }),
    recordChainDepthExceeded: () => metricEvents.push({ type: "hard_depth" }),
    recordChainStopped: (reason: string) => metricEvents.push({ type: "stopped", reason }),
    recordChainTokenUsage: (tokens: number) => metricEvents.push({ type: "tokens", tokens }),
    recordChainSoftDepth: () => metricEvents.push({ type: "soft_depth" }),
  } as unknown as AgentMetricsPort;
  const engine = (limits: { maxChainDepth?: number; maxChainTokens?: number; chainDepthSoftLimit?: number; stalledCycleHopLimit?: number } = {}) => new DispatchChainEngine({
    conversationRepo: {
      getActiveParticipants: vi.fn().mockResolvedValue([]),
      getParticipant: vi.fn().mockResolvedValue(null),
    },
    queryOtter: { getById: vi.fn().mockResolvedValue(null) },
    logger, healingRepo, metrics,
    entryRepo: { getUnreadEntries: vi.fn().mockResolvedValue([]), getEntries: vi.fn().mockResolvedValue([]) },
    invokeRepo: { getInvokeById: vi.fn(async (id: string) => invokes.get(id) ?? null) },
    ...limits,
  } as never);
  return { invokes, logger, healingEvents, metricEvents, engine };
}

/** A deterministic n-hop chain. Its topology and usage are explicit, no LLM involved. */
function continuingChain(invokes: ReturnType<typeof fixture>["invokes"], finishAt: number, tokenUsageDelta: InvokeFnResult["tokenUsageDelta"] | null = usage()) {
  let count = 0;
  const invoked: string[] = [];
  const invokeFn = async ({ otterId }: { otterId: string }): Promise<InvokeFnResult> => {
    count++;
    invoked.push(otterId);
    const messageId = `invoke-${count}`;
    const next = count >= finishAt ? [] : [otterId === "otter-a" ? "otter-b" : "otter-a"];
    invokes.set(messageId, { id: messageId, status: "completed", otterId, talkingStonePassedTo: next, endedAt: "2026-10-26T00:00:00Z" });
    return { messageId, ...(tokenUsageDelta !== null ? { tokenUsageDelta: tokenUsageDelta ?? undefined } : { tokenUsageDelta: usage(0) }) };
  };
  return { invokeFn, invoked, count: () => count };
}

describe("F20261026ctbg 发言链资源边界", () => {
  it("#1637 复现：有真实 token 增量的合法链在第 101 跳完成，不再被固定 100 跳误杀", async () => {
    const f = fixture();
    const chain = continuingChain(f.invokes, 101);
    const stops: ChainStop[] = [];
    await f.engine().executeChain({
      conversationId: "conv-1", userMessageContent: "持续推进", senderId: "user", initialTargets: ["otter-a"],
      invokeFn: chain.invokeFn, callbacks: { onChainStopped: stop => { stops.push(stop); } },
    });
    expect(chain.count()).toBe(101);
    expect(stops).toEqual([]);
  });

  it("token 是主约束：超预算后保留 pendingTargets，停止原因与消耗量完整", async () => {
    const f = fixture();
    const chain = continuingChain(f.invokes, 10, usage(100));
    const stops: ChainStop[] = [];
    await f.engine({ maxChainTokens: 150, stalledCycleHopLimit: 50 }).executeChain({
      conversationId: "conv-1", userMessageContent: "高消耗任务", senderId: "user", initialTargets: ["otter-a"],
      invokeFn: chain.invokeFn, callbacks: { onChainStopped: stop => { stops.push(stop); } },
    });
    expect(chain.count()).toBe(2);
    expect(stops).toEqual([expect.objectContaining({ reason: "token_budget", depth: 2, totalTokens: 200, pendingTargets: ["otter-a"] })]);
    expect(stops[0]?.healingEventId).toEqual(expect.any(String));
    expect(f.metricEvents).toContainEqual({ type: "stopped", reason: "token_budget" });
    expect(f.metricEvents).toContainEqual({ type: "tokens", tokens: 200 });
    expect(f.healingEvents).toContainEqual(expect.objectContaining({ severity: "high", context: expect.objectContaining({ chainStop: expect.objectContaining({ reason: "token_budget" }) }) }));
  });

  it("软深度只告警不阻断，且不制造 healing 写入异常", async () => {
    const f = fixture();
    const chain = continuingChain(f.invokes, 4);
    const stops: ChainStop[] = [];
    await f.engine({ chainDepthSoftLimit: 2, maxChainDepth: 10 }).executeChain({
      conversationId: "conv-1", userMessageContent: "长任务", senderId: "user", initialTargets: ["otter-a"],
      invokeFn: chain.invokeFn, callbacks: { onChainStopped: stop => { stops.push(stop); } },
    });
    expect(chain.count()).toBe(4);
    expect(stops).toEqual([]);
    expect(f.metricEvents.filter(event => event.type === "soft_depth")).toHaveLength(1);
    expect(f.healingEvents).toContainEqual(expect.objectContaining({ severity: "medium", context: expect.objectContaining({ chainSoftDepth: 2 }) }));
  });

  it("正常 A→B→A 返修不因拓扑成环被截断", async () => {
    const f = fixture();
    const chain = continuingChain(f.invokes, 8);
    await f.engine({ stalledCycleHopLimit: 2 }).executeChain({
      conversationId: "conv-1", userMessageContent: "返修", senderId: "user", initialTargets: ["otter-a"], invokeFn: chain.invokeFn,
    });
    expect(chain.count()).toBe(8);
  });

  it("重复回路且无可计量活动达到阈值才停滞熔断", async () => {
    const f = fixture();
    const chain = continuingChain(f.invokes, 20, null);
    const stops: ChainStop[] = [];
    await f.engine({ stalledCycleHopLimit: 3 }).executeChain({
      conversationId: "conv-1", userMessageContent: "异常回路", senderId: "user", initialTargets: ["otter-a"],
      invokeFn: chain.invokeFn, callbacks: { onChainStopped: stop => { stops.push(stop); } },
    });
    expect(stops).toEqual([expect.objectContaining({ reason: "stalled_cycle", depth: 6, pendingTargets: ["otter-a"] })]);
    expect(chain.count()).toBeLessThan(20);
  });

  it("缺失 usage 不冒充停滞证据，且零 token 的小显式预算仍优先生效", async () => {
    const f = fixture();
    const chain = continuingChain(f.invokes, 10, null);
    const stops: ChainStop[] = [];
    await f.engine({ stalledCycleHopLimit: 2 }).executeChain({
      conversationId: "conv-1", userMessageContent: "旧 adapter", senderId: "user", initialTargets: ["otter-a"],
      invokeFn: async params => { const result = await chain.invokeFn(params); delete result.tokenUsageDelta; return result; },
      callbacks: { onChainStopped: stop => { stops.push(stop); } },
    });
    expect(chain.count()).toBe(10);
    expect(stops).toEqual([]);
  });

  it("cacheRead/cacheWrite 同样进入链预算", async () => {
    const f = fixture();
    const chain = continuingChain(f.invokes, 10, { input: 0, output: 0, cacheRead: 80, cacheWrite: 20 });
    const stops: ChainStop[] = [];
    await f.engine({ maxChainTokens: 150 }).executeChain({
      conversationId: "conv-1", userMessageContent: "缓存消耗", senderId: "user", initialTargets: ["otter-a"],
      invokeFn: chain.invokeFn, callbacks: { onChainStopped: stop => { stops.push(stop); } },
    });
    expect(chain.count()).toBe(2);
    expect(stops[0]).toMatchObject({ reason: "token_budget", totalTokens: 200 });
  });

  it("最终深度仍是逃生上限，旧指标保留 hard_depth 语义", async () => {
    const f = fixture();
    const chain = continuingChain(f.invokes, 20);
    const stops: ChainStop[] = [];
    await f.engine({ maxChainDepth: 3, stalledCycleHopLimit: 50 }).executeChain({
      conversationId: "conv-1", userMessageContent: "失控任务", senderId: "user", initialTargets: ["otter-a"],
      invokeFn: chain.invokeFn, callbacks: { onChainStopped: stop => { stops.push(stop); } },
    });
    expect(chain.count()).toBe(3);
    expect(stops).toEqual([expect.objectContaining({ reason: "hard_depth", depth: 3, pendingTargets: ["otter-b"] })]);
    expect(f.metricEvents.filter(event => event.type === "hard_depth")).toHaveLength(1);
  });
});

describe("F20261026ctbg 单次 invoke token 增量", () => {
  it("快照按四分量差分，重复 session 历史不重复计账", () => {
    expect(diffTokenUsage({ input: 100, output: 20, cacheRead: 40, cacheWrite: 2 }, { input: 150, output: 25, cacheRead: 60, cacheWrite: 5 }))
      .toEqual({ input: 50, output: 5, cacheRead: 20, cacheWrite: 3 });
  });

  it("换世或重置后的回落快照取当前值，不产生负消耗", () => {
    expect(diffTokenUsage({ input: 1000, output: 100, cacheRead: 500, cacheWrite: 10 }, { input: 20, output: 5, cacheRead: 4, cacheWrite: 1 }))
      .toEqual({ input: 20, output: 5, cacheRead: 4, cacheWrite: 1 });
  });
});
