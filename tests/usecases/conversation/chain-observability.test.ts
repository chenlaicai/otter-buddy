import { describe, expect, it, vi } from "vitest";
import { DispatchChainEngine, type InvokeFnResult } from "@usecases/conversation/dispatch-chain-engine";
import type { AgentMetricsPort } from "@usecases/ports/agent-metrics-port";
import type { TokenUsage } from "@usecases/conversation/token-usage";

interface InvokeRow { id: string; status: string; otterId: string; talkingStonePassedTo: string[]; endedAt: string }
const usage = (input = 1): TokenUsage => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });

function fixture(legacyLimits: Record<string, number> = {}) {
  const invokes = new Map<string, InvokeRow>();
  const warnings: Array<{ message: string; context: Record<string, unknown> }> = [];
  const metrics: Array<{ name: string; value: number }> = [];
  const engine = new DispatchChainEngine({
    conversationRepo: { getActiveParticipants: vi.fn().mockResolvedValue([]), getParticipant: vi.fn().mockResolvedValue(null) },
    queryOtter: { getById: vi.fn().mockResolvedValue(null) },
    logger: {
      info: vi.fn(), error: vi.fn(), debug: vi.fn(),
      warn: (message: string, context: Record<string, unknown>) => warnings.push({ message, context }),
    },
    metrics: {
      recordChainHops: (count: number) => metrics.push({ name: "hops", value: count }),
      recordChainTokenUsage: (tokens: number) => metrics.push({ name: "tokens", value: tokens }),
      recordChainTelemetryGap: () => metrics.push({ name: "telemetry_gap", value: 1 }),
    } as unknown as AgentMetricsPort,
    entryRepo: { getUnreadEntries: vi.fn().mockResolvedValue([]), getEntries: vi.fn().mockResolvedValue([]) },
    invokeRepo: { getInvokeById: vi.fn(async (id: string) => invokes.get(id) ?? null) },
    ...legacyLimits,
  } as never);
  return { invokes, warnings, metrics, engine };
}

function continuingChain(invokes: Map<string, InvokeRow>, finishAt: number, delta: TokenUsage | null = usage()) {
  let count = 0;
  const invokeFn = async ({ otterId }: { otterId: string }): Promise<InvokeFnResult> => {
    count++;
    const messageId = `invoke-${count}`;
    invokes.set(messageId, {
      id: messageId, status: "completed", otterId,
      talkingStonePassedTo: count >= finishAt ? [] : [otterId === "A" ? "B" : "A"],
      endedAt: "2026-10-26T00:00:00Z",
    });
    return { messageId, ...(delta === null ? {} : { tokenUsageDelta: delta }) };
  };
  return { invokeFn, count: () => count };
}

describe("F20261026ctbg 链观测不替任务判死", () => {
  it("合法链跨过旧 100 跳，在明确的第 101 跳收尾", async () => {
    const f = fixture();
    const chain = continuingChain(f.invokes, 101);
    await f.engine.executeChain({ conversationId: "conv-1", userMessageContent: "长任务", senderId: "user", initialTargets: ["A"], invokeFn: chain.invokeFn });
    expect(chain.count()).toBe(101);
  });

  it("即使旧配置写了小 maxChainDepth，也不按总深度终止正常协作", async () => {
    const f = fixture({ maxChainDepth: 3 });
    const chain = continuingChain(f.invokes, 2_001);
    await f.engine.executeChain({ conversationId: "conv-1", userMessageContent: "超长任务", senderId: "user", initialTargets: ["A"], invokeFn: chain.invokeFn });
    expect(chain.count()).toBe(2_001);
    expect(f.metrics).toContainEqual({ name: "hops", value: 2_001 });
  });

  it("即使旧配置写了小 maxChainTokens，正常协作超过 10M 仍继续并完成", async () => {
    const f = fixture({ maxChainTokens: 150 });
    const chain = continuingChain(f.invokes, 11, usage(1_000_000));
    await f.engine.executeChain({ conversationId: "conv-1", userMessageContent: "高消耗任务", senderId: "user", initialTargets: ["A"], invokeFn: chain.invokeFn });
    expect(chain.count()).toBe(11);
    expect(f.metrics).toContainEqual({ name: "tokens", value: 11_000_000 });
    expect(f.warnings.filter(w => w.message.startsWith("发言链"))).toEqual([]);
  });

  it("重复回路和显式零 delta 不再触发停滞停止", async () => {
    const f = fixture({ stalledCycleHopLimit: 1 });
    const chain = continuingChain(f.invokes, 20, usage(0));
    await f.engine.executeChain({ conversationId: "conv-1", userMessageContent: "返修", senderId: "user", initialTargets: ["A"], invokeFn: chain.invokeFn });
    expect(chain.count()).toBe(20);
  });

  it("计量缺口每链只告警和计数一次，完整记录已知消耗但不停止", async () => {
    const f = fixture();
    let count = 0;
    const invokeFn = async ({ otterId }: { otterId: string }): Promise<InvokeFnResult> => {
      count++;
      const messageId = `invoke-${count}`;
      f.invokes.set(messageId, { id: messageId, status: "completed", otterId, talkingStonePassedTo: count < 3 ? ["A"] : [], endedAt: "2026-10-26T00:00:00Z" });
      return { messageId, ...(count === 2 ? {} : { tokenUsageDelta: usage(50) }) };
    };
    await f.engine.executeChain({ conversationId: "conv-1", userMessageContent: "旧 adapter", senderId: "user", initialTargets: ["A"], invokeFn });
    expect(count).toBe(3);
    expect(f.metrics).toContainEqual({ name: "tokens", value: 100 });
    expect(f.metrics.filter(m => m.name === "telemetry_gap")).toEqual([{ name: "telemetry_gap", value: 1 }]);
    const gapWarnings = f.warnings.filter(w => w.message === "发言链计量缺口：仅观测，不停止");
    expect(gapWarnings).toHaveLength(1);
    expect(gapWarnings[0]?.context).toMatchObject({ depth: 2, totalTokens: 50, pendingTargets: ["A"], telemetryGap: true });
  });

  it("所有 fulfilled 结果先计量，即使具体 guard 已决定终链", async () => {
    const f = fixture();
    const previousSelfYields = Array.from({ length: 4 }, (_, i) => ({ id: `yield-${i}`, entryType: "yield", senderType: "otter", senderId: "A", senderName: "A", body: "", sequenceNum: 4 - i, invokeId: `old-${i}`, yieldTargets: ["A"] }));
    const engine = new DispatchChainEngine({
      conversationRepo: { getActiveParticipants: vi.fn().mockResolvedValue([]), getParticipant: vi.fn().mockResolvedValue(null) },
      queryOtter: { getById: vi.fn().mockResolvedValue(null) },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      metrics: { recordChainHops: () => {}, recordChainTokenUsage: (tokens: number) => f.metrics.push({ name: "tokens", value: tokens }) } as never,
      entryRepo: { getUnreadEntries: vi.fn().mockResolvedValue([]), getEntries: vi.fn().mockResolvedValue(previousSelfYields) },
      invokeRepo: { getInvokeById: vi.fn(async (id: string) => f.invokes.get(id) ?? null) },
    } as never);
    f.invokes.set("invoke-A", { id: "invoke-A", status: "completed", otterId: "A", talkingStonePassedTo: ["A"], endedAt: "2026-10-26T00:00:00Z" });
    f.invokes.set("invoke-B", { id: "invoke-B", status: "completed", otterId: "B", talkingStonePassedTo: [], endedAt: "2026-10-26T00:00:00Z" });
    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "fanout", senderId: "user", initialTargets: ["A", "B"],
      invokeFn: async ({ otterId }) => ({ messageId: `invoke-${otterId}`, tokenUsageDelta: otterId === "A" ? usage(1) : usage(5_000) }),
    });
    expect(f.metrics).toContainEqual({ name: "tokens", value: 5_001 });
  });
});
