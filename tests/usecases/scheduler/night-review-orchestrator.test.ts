/**
 * P2b2：夜间审视编排（NightReviewOrchestrator）单测。
 *
 * 钉住治量闭环（v4 §4.4 不丢不重 + §4.5 fyi 否决锚）：
 * - 幂等：claim settled 短路（LLM 重跑不重）
 * - 水位：首跑回看窗 / settle 档 through 推进 / 未清失败区间取较早（停机补跑不丢审）
 * - 失败：同区间重跑原区间、连败达阈值 skip + healing、invoke 抛错/未全量处置 recordFailure
 * - 獭生命周期：召唤（type=night-reviewer）+ 快照范围写 context + 审后解散（finally）
 * - fyi：变更集 matter 否决锚 + system entry 汇总
 */
import { describe, it, expect, vi } from "vitest";
import { NightReviewOrchestrator } from "@usecases/scheduler/night-review-orchestrator";
import { NIGHT_REVIEW_RANGE_CONTEXT_KEY, NIGHT_REVIEW_TASK_ID } from "@entities/memory/consolidation-state";
import type { ConsolidationState } from "@entities/memory/consolidation-state";
import type { MemoryEntry } from "@entities/memory/memory-entry";
import type { Logger } from "@usecases/ports/logger";

/** Asia/Shanghai 2026-11-18 20:00 = UTC 12:00 */
const NOW = new Date("2026-11-18T12:00:00.000Z");
const DATE = "2026-11-18";
const REVIEW_KEY = `review:${DATE}:${NIGHT_REVIEW_TASK_ID}`;
const CONV = "conv-night";

function makeBelief(id: string, createdAt: string, content = `belief-${id}`): MemoryEntry {
  return {
    id,
    content,
    contentType: "belief",
    layer: "working",
    sourceType: "message",
    sourceId: null,
    sourceName: null,
    conversationId: CONV,
    metadata: { kind: "state", status: "recorded", anchors: [`anchor-${id}`] },
    createdAt,
    updatedAt: createdAt,
    embeddingStatus: "none",
    tokens: 10,
    weightVersion: 0,
    dead: false,
  } as unknown as MemoryEntry;
}

interface Harness {
  orch: NightReviewOrchestrator;
  claimResult: { settled: boolean; resultJson: string | null; failingRange: { after: string; through: string } | null; failures: number };
  states: ConsolidationState[];
  beliefs: MemoryEntry[];
  terminalStatuses: Map<string, string>;
  invokeImpl?: () => Promise<void>;
  createdOtters: Array<{ name: string; type: string }>;
  dissolved: string[];
  contextSets: Array<{ otterId: string; key: string; value: string }>;
  completes: Array<{ key: string; json: string }>;
  failures: Array<{ key: string; after: string; through: string }>;
  matters: Array<Record<string, unknown>>;
  entries: string[];
  healings: Array<Record<string, unknown>>;
  listCalls: Array<{ status: string; after: string; through: string }>;
}

function makeHarness(overrides?: Partial<Harness>): Harness {
  const h: Harness = {
    orch: undefined as unknown as NightReviewOrchestrator,
    claimResult: { settled: false, resultJson: null, failingRange: null, failures: 0 },
    states: [],
    beliefs: [makeBelief("b1", "2026-11-18T05:00:00.000Z"), makeBelief("b2", "2026-11-18T06:00:00.000Z")],
    terminalStatuses: new Map([["b1", "verified"], ["b2", "disputed"]]),
    createdOtters: [],
    dissolved: [],
    contextSets: [],
    completes: [],
    failures: [],
    matters: [],
    entries: [],
    healings: [],
    listCalls: [],
    ...overrides,
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const claim = vi.fn(async () => h.claimResult);
  const complete = vi.fn(async (key: string, json: string) => { h.completes.push({ key, json }); });
  const recordFailure = vi.fn(async (key: string, after: string, through: string) => {
    h.failures.push({ key, after, through });
    return { failures: 1, shouldSkip: false };
  });
  h.orch = new NightReviewOrchestrator({
    manageConsolidationState: { claim, complete, recordFailure } as never,
    consolidationRepo: { listByTaskId: vi.fn(async () => h.states) } as never,
    memoryReader: {
      listBeliefsByStatus: vi.fn(async (status: string, after: string, through: string) => {
        h.listCalls.push({ status, after, through });
        return h.beliefs;
      }),
      getDetails: vi.fn(async (ids: string[]) =>
        ids.flatMap((id) => {
          const status = h.terminalStatuses.get(id);
          return status ? [{ ...h.beliefs.find((b) => b.id === id)!, metadata: { kind: "state", status, anchors: [`anchor-${id}`] } }] : [];
        }),
      ),
    } as never,
    createOtter: {
      execute: vi.fn(async (input: { name: string; type: string }) => {
        h.createdOtters.push({ name: input.name, type: input.type });
        return { id: `otter-${h.createdOtters.length}`, name: input.name, type: input.type };
      }),
    } as never,
    dissolveOtter: { execute: vi.fn(async (id: string) => { h.dissolved.push(id); }) } as never,
    otterContextRepo: {
      set: vi.fn(async (otterId: string, key: string, value: string) => { h.contextSets.push({ otterId, key, value }); }),
    } as never,
    agentTurnPort: {
      invokeConversation: vi.fn(async () => {
        h.entries.push("invoke");
        if (h.invokeImpl) return h.invokeImpl();
        return { invokeId: "inv-1", messageId: "inv-1", duration: 1 };
      }),
    } as never,
    registerMatter: {
      execute: vi.fn(async (input: Record<string, unknown>) => {
        h.matters.push(input);
        return { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", ...input } as never;
      }),
    } as never,
    healingRepo: {
      create: vi.fn(async (e: Record<string, unknown>) => { h.healings.push(e); }),
    } as never,
    sendEntry: {
      createSystemEntry: vi.fn(async (input: { body: string }) => { h.entries.push(input.body); return { entry: { id: "e" } }; }),
    } as never,
    logger,
  });
  return h;
}

describe("NightReviewOrchestrator（P2b2）", () => {
  it("幂等撞键：claim settled 直接返回原结果，不召唤獭不重跑", async () => {
    const h = makeHarness();
    h.claimResult = {
      settled: true,
      resultJson: JSON.stringify({ date: DATE, after: "a", through: "t", reviewed: 2, changes: [{ id: "b1", to: "verified" }] }),
      failingRange: null,
      failures: 0,
    };
    const out = await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(out.alreadySettled).toBe(true);
    expect(out.reviewed).toBe(2);
    expect(h.createdOtters).toHaveLength(0);
    expect(h.completes).toHaveLength(0);
  });

  it("首跑无档：after 兜底回看窗（now - 30h），through = now", async () => {
    const h = makeHarness();
    await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(h.listCalls[0]).toEqual({
      status: "recorded",
      after: "2026-11-17T06:00:00.000Z",
      through: "2026-11-18T12:00:00.000Z",
    });
  });

  it("settle 水位推进：after = 最新 settle 档 through（不重跑已审段）", async () => {
    const h = makeHarness();
    h.states = [{
      reviewKey: `review:2026-11-17:${NIGHT_REVIEW_TASK_ID}`,
      failedAfter: null, failedThrough: null, failures: 0,
      resultJson: JSON.stringify({ date: "2026-11-17", after: "x", through: "2026-11-17T20:00:00.000Z", reviewed: 1, changes: [] }),
      updatedAt: "2026-11-17T20:00:01.000Z",
    }];
    await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(h.listCalls[0].after).toBe("2026-11-17T20:00:00.000Z");
  });

  it("未清失败区间不丢审：after 取 min(settle 水位, 最早失败区间起点)", async () => {
    const h = makeHarness();
    h.states = [
      {
        reviewKey: `review:2026-11-16:${NIGHT_REVIEW_TASK_ID}`,
        failedAfter: null, failedThrough: null, failures: 0,
        resultJson: JSON.stringify({ date: "2026-11-16", after: "x", through: "2026-11-16T20:00:00.000Z", reviewed: 1, changes: [] }),
        updatedAt: "2026-11-16T20:00:01.000Z",
      },
      {
        reviewKey: `review:2026-11-17:${NIGHT_REVIEW_TASK_ID}`,
        failedAfter: "2026-11-16T18:00:00.000Z", failedThrough: "2026-11-17T20:00:00.000Z", failures: 1,
        resultJson: null,
        updatedAt: "2026-11-17T21:00:00.000Z",
      },
    ];
    await h.orch.execute({ conversationId: CONV, now: NOW });
    // 跨天新键：失败档的 failedAfter（11-16 18:00）早于 settle 水位（11-16 20:00）→ 从 18:00 继续
    expect(h.listCalls[0].after).toBe("2026-11-16T18:00:00.000Z");
  });

  it("同档失败重跑：claim 返回 failingRange 时重做原区间（双端原值）", async () => {
    const h = makeHarness();
    h.claimResult = {
      settled: false, resultJson: null, failures: 1,
      failingRange: { after: "2026-11-18T02:00:00.000Z", through: "2026-11-18T03:00:00.000Z" },
    };
    await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(h.listCalls[0]).toEqual({
      status: "recorded",
      after: "2026-11-18T02:00:00.000Z",
      through: "2026-11-18T03:00:00.000Z",
    });
  });

  it("连败达阈值：skip + healing「这段没审视成」，不召唤獭", async () => {
    const h = makeHarness();
    h.claimResult = {
      settled: false, resultJson: null, failures: 3,
      failingRange: { after: "2026-11-18T02:00:00.000Z", through: "2026-11-18T03:00:00.000Z" },
    };
    const out = await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(out.skipped).toBe(true);
    expect(h.healings).toHaveLength(1);
    expect(String(h.healings[0].description)).toContain("没审视成");
    expect(h.createdOtters).toHaveLength(0);
    expect(h.completes).toHaveLength(0);
  });

  it("空清单：complete 空变更集（当天无 recorded 也是合法 settle），不召唤獭", async () => {
    const h = makeHarness();
    h.beliefs = [];
    const out = await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(out.reviewed).toBe(0);
    expect(h.completes).toHaveLength(1);
    expect(JSON.parse(h.completes[0].json)).toMatchObject({ date: DATE, reviewed: 0, changes: [] });
    expect(h.createdOtters).toHaveLength(0);
    // 空集无需否决锚
    expect(h.matters).toHaveLength(0);
  });

  it("全量处置成功：召唤夜审獭 + 范围写 context + complete + matter 锚 + 双 entry + 解散", async () => {
    const h = makeHarness();
    const out = await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(REVIEW_KEY.startsWith(`review:${DATE}:`)).toBe(true);
    // 召唤档案
    expect(h.createdOtters[0].type).toBe("night-reviewer");
    expect(h.createdOtters[0].name).toContain(DATE);
    // 快照范围写进獭 context（工具层 fail-closed 校验的数据源）
    expect(h.contextSets[0].key).toBe(NIGHT_REVIEW_RANGE_CONTEXT_KEY);
    expect(JSON.parse(h.contextSets[0].value)).toEqual({
      after: "2026-11-17T06:00:00.000Z",
      through: "2026-11-18T12:00:00.000Z",
    });
    // 变更集存档
    expect(h.completes).toHaveLength(1);
    const changeset = JSON.parse(h.completes[0].json);
    expect(changeset.changes).toEqual([
      { id: "b1", to: "verified" },
      { id: "b2", to: "disputed" },
    ]);
    // fyi：开始 + 完成两条 system entry + matter 否决锚（WAITING_PARTNER，payload 含变更集）
    expect(h.entries.filter((e) => e !== "invoke")).toHaveLength(2);
    expect(h.matters).toHaveLength(1);
    expect(h.matters[0].initialState).toBe("WAITING_PARTNER");
    expect(JSON.parse(String(h.matters[0].payload)).changes).toHaveLength(2);
    expect(out.matterAnchor).toMatch(/^M-/);
    // 獭解散
    expect(h.dissolved).toEqual(["otter-1"]);
  });

  it("未全量处置（recorded 残留）：recordFailure 不 complete，错误上抛，獭仍解散", async () => {
    const h = makeHarness();
    h.terminalStatuses = new Map([["b1", "verified"], ["b2", "recorded"]]);
    await expect(h.orch.execute({ conversationId: CONV, now: NOW })).rejects.toThrow("未全量处置");
    expect(h.completes).toHaveLength(0);
    expect(h.failures).toEqual([{ key: REVIEW_KEY, after: "2026-11-17T06:00:00.000Z", through: "2026-11-18T12:00:00.000Z" }]);
    expect(h.dissolved).toEqual(["otter-1"]);
  });

  it("invoke 抛错：recordFailure + 错误上抛 + 獭 finally 解散", async () => {
    const h = makeHarness();
    h.invokeImpl = async () => { throw new Error("LLM 会话崩溃"); };
    await expect(h.orch.execute({ conversationId: CONV, now: NOW })).rejects.toThrow("LLM 会话崩溃");
    expect(h.failures).toHaveLength(1);
    expect(h.completes).toHaveLength(0);
    expect(h.dissolved).toEqual(["otter-1"]);
  });

  it("审视日按 Asia/Shanghai 墙钟：UTC 11-18 20:00 = 上海 11-19 04:00 → 键落 11-19", async () => {
    const h = makeHarness();
    h.beliefs = [];
    await h.orch.execute({ conversationId: CONV, now: new Date("2026-11-18T20:00:00.000Z") });
    expect(h.completes[0].key).toBe(`review:2026-11-19:${NIGHT_REVIEW_TASK_ID}`);
  });

  it("settle 档 resultJson 损坏：水位降级到兜底回看窗（不炸编排）", async () => {
    const h = makeHarness();
    h.states = [{
      reviewKey: `review:2026-11-17:${NIGHT_REVIEW_TASK_ID}`,
      failedAfter: null, failedThrough: null, failures: 0,
      resultJson: "corrupted{",
      updatedAt: "2026-11-17T20:00:01.000Z",
    }];
    h.beliefs = [];
    await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(h.listCalls[0].after).toBe("2026-11-17T06:00:00.000Z");
  });
});
