/**
 * P2b2：夜间审视编排（NightReviewOrchestrator）单测。
 *
 * 钉住治量闭环（v4 §4.4 不丢不重 + §4.5 fyi 否决锚）：
 * - 幂等：claim settled 短路（LLM 重跑不重）
 * - 水位：首跑回看窗 / settle 档 through 推进 / 未清失败区间取较早（停机补跑不丢审）
 * - 失败：同区间重跑原区间、连败达阈值当次 skip + healing（不上抛熔断任务）、
 *   invoke 抛错/未全量处置 recordFailure
 * - 审计面（审-1946 发现 3）：变更集覆盖区间全集（四状态）——失败重跑时上轮已迁移
 *   条目不丢审计、不丢 fyi 否决锚；全部迁移后崩溃的重跑正确补发
 * - settle 顺序（发现 4）：fyi 先于 complete——report 失败可重跑补发，matter 按
 *   title 查重防重复登记
 * - 獭生命周期（发现 5）：召唤全程序 try/finally（context 写入失败也记账+解散），
 *   dissolve 失败报 healing
 * - 连败当次处理（发现 7）：recordFailure 返回 shouldSkip 时当次报 healing 返回
 *   skipped，不上抛（scheduler 不熔断，次日新键重试）
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
const DEFAULT_AFTER = "2026-11-17T06:00:00.000Z"; // NOW - 30h 兜底回看窗

interface Harness {
  orch: NightReviewOrchestrator;
  claimResult: { settled: boolean; resultJson: string | null; failingRange: { after: string; through: string } | null; failures: number };
  failureOutcome: { failures: number; shouldSkip: boolean };
  states: ConsolidationState[];
  /** belief id → 当前状态（模拟真实状态机；invoke 时测试自行迁移） */
  liveStatuses: Map<string, string>;
  invokeImpl?: () => Promise<void>;
  createOtterImpl?: () => Promise<void>;
  createdOtters: Array<{ name: string; type: string }>;
  dissolved: string[];
  contextSets: Array<{ otterId: string; key: string; value: string }>;
  contextSetImpl?: (otterId: string, key: string, value: string) => Promise<void>;
  completes: Array<{ key: string; json: string }>;
  failures: Array<{ key: string; after: string; through: string }>;
  matters: Array<Record<string, unknown>>;
  existingMatters: Array<{ id: string; title: string }>;
  entries: string[];
  entryImpl?: (body: string) => Promise<void>;
  healings: Array<Record<string, unknown>>;
  listCalls: Array<{ status: string; after: string; through: string }>;
  dissolveImpl?: (id: string) => Promise<void>;
}

function beliefIds(h: Harness): Map<string, MemoryEntry> {
  const mk = (id: string): MemoryEntry => ({
    id, content: `belief-${id}`, contentType: "belief", layer: "working",
    sourceType: "message", sourceId: null, sourceName: null, conversationId: CONV,
    metadata: { kind: "state", status: h.liveStatuses.get(id) ?? "recorded", anchors: [`anchor-${id}`] },
    createdAt: `2026-11-18T0${5 + Number(id.slice(1)) % 4}:00:00.000Z`,
    updatedAt: "2026-11-18T06:00:00.000Z",
    embeddingStatus: "none", tokens: 10, weightVersion: 0, dead: false,
  } as unknown as MemoryEntry);
  const m = new Map<string, MemoryEntry>();
  for (const id of h.liveStatuses.keys()) m.set(id, mk(id));
  return m;
}

function makeHarness(overrides?: Partial<Harness>): Harness {
  const h: Harness = {
    orch: undefined as unknown as NightReviewOrchestrator,
    claimResult: { settled: false, resultJson: null, failingRange: null, failures: 0 },
    failureOutcome: { failures: 1, shouldSkip: false },
    states: [],
    liveStatuses: new Map([["b1", "recorded"], ["b2", "recorded"]]),
    createdOtters: [],
    dissolved: [],
    contextSets: [],
    completes: [],
    failures: [],
    matters: [],
    existingMatters: [],
    entries: [],
    healings: [],
    listCalls: [],
    ...overrides,
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  h.orch = new NightReviewOrchestrator({
    manageConsolidationState: {
      claim: vi.fn(async () => h.claimResult),
      complete: vi.fn(async (key: string, json: string) => { h.completes.push({ key, json }); }),
      recordFailure: vi.fn(async (key: string, after: string, through: string) => {
        h.failures.push({ key, after, through });
        return h.failureOutcome;
      }),
    } as never,
    consolidationRepo: { listByTaskId: vi.fn(async () => h.states) } as never,
    memoryReader: {
      listBeliefsByStatus: vi.fn(async (status: string, after: string, through: string) => {
        h.listCalls.push({ status, after, through });
        const all = beliefIds(h);
        return [...all.values()].filter((b) => (b.metadata as { status: string }).status === status);
      }),
      getDetails: vi.fn(async (ids: string[]) => {
        const all = beliefIds(h);
        return ids.flatMap((id) => (h.liveStatuses.has(id) ? [all.get(id)!] : []));
      }),
    } as never,
    createOtter: {
      execute: vi.fn(async (input: { name: string; type: string }) => {
        if (h.createOtterImpl) return h.createOtterImpl();
        h.createdOtters.push({ name: input.name, type: input.type });
        return { id: `otter-${h.createdOtters.length}`, name: input.name, type: input.type };
      }),
    } as never,
    dissolveOtter: { execute: vi.fn(async (id: string) => { h.dissolved.push(id); if (h.dissolveImpl) await h.dissolveImpl(id); }) } as never,
    otterContextRepo: {
      set: vi.fn(async (otterId: string, key: string, value: string) => {
        if (h.contextSetImpl) return h.contextSetImpl(otterId, key, value);
        h.contextSets.push({ otterId, key, value });
      }),
    } as never,
    agentTurnPort: {
      invokeConversation: vi.fn(async () => {
        h.entries.push("invoke");
        if (h.invokeImpl) await h.invokeImpl();
        return { invokeId: "inv-1", messageId: "inv-1", duration: 1 };
      }),
    } as never,
    registerMatter: {
      execute: vi.fn(async (input: Record<string, unknown>) => {
        h.matters.push(input);
        return { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", ...input } as never;
      }),
    } as never,
    matterRepo: {
      findByConversation: vi.fn(async (_conv: string, _filter?: unknown, limit?: number) => {
        // delta 审视发现 17：查重窗口语义——mock 镜像 repo 的 limit 截断（默认 50）
        const cap = limit ?? 50;
        return h.existingMatters.slice(0, cap).map((m) => ({ id: m.id, title: m.title }));
      }),
    } as never,
    healingRepo: {
      create: vi.fn(async (e: Record<string, unknown>) => { h.healings.push(e); }),
    } as never,
    sendEntry: {
      createSystemEntry: vi.fn(async (input: { body: string }) => {
        if (h.entryImpl) return h.entryImpl(input.body);
        h.entries.push(input.body);
        return { entry: { id: "e" } };
      }),
    } as never,
    logger,
  });
  return h;
}

describe("NightReviewOrchestrator（P2b2 基础治量）", () => {
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
    h.liveStatuses = new Map();
    await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(h.listCalls[0]).toEqual({ status: "recorded", after: DEFAULT_AFTER, through: NOW.toISOString() });
  });

  it("settle 水位推进：after = 最新 settle 档 through（不重跑已审段）", async () => {
    const h = makeHarness();
    h.liveStatuses = new Map();
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
    h.liveStatuses = new Map();
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
    expect(h.listCalls[0].after).toBe("2026-11-16T18:00:00.000Z");
  });

  it("同档失败重跑：claim 返回 failingRange 时重做原区间（双端原值）", async () => {
    const h = makeHarness();
    h.claimResult = {
      settled: false, resultJson: null, failures: 1,
      failingRange: { after: "2026-11-18T02:00:00.000Z", through: "2026-11-18T03:00:00.000Z" },
    };
    h.invokeImpl = async () => {
      h.liveStatuses.set("b1", "verified");
      h.liveStatuses.set("b2", "disputed");
    };
    await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(h.listCalls[0]).toEqual({ status: "recorded", after: "2026-11-18T02:00:00.000Z", through: "2026-11-18T03:00:00.000Z" });
  });

  it("连败达阈值（claim 预置）：skip + healing「这段没审视成」，不召唤獭", async () => {
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

  it("空区间：complete 空变更集（当天无任何 belief），不召唤獭", async () => {
    const h = makeHarness();
    h.liveStatuses = new Map();
    const out = await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(out.reviewed).toBe(0);
    expect(h.completes).toHaveLength(1);
    expect(JSON.parse(h.completes[0].json)).toMatchObject({ date: DATE, reviewed: 0, changes: [] });
    expect(h.createdOtters).toHaveLength(0);
    expect(h.matters).toHaveLength(0);
  });

  it("审视日按 Asia/Shanghai 墙钟：UTC 11-18 20:00 = 上海 11-19 04:00 → 键落 11-19", async () => {
    const h = makeHarness();
    h.liveStatuses = new Map();
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
    h.liveStatuses = new Map();
    await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(h.listCalls[0].after).toBe(DEFAULT_AFTER);
  });
});

describe("NightReviewOrchestrator（成功链路 + 审计面）", () => {
  it("全量处置成功：召唤夜审獭 + 范围写 context + complete + matter 锚 + 双 entry + 解散", async () => {
    const h = makeHarness();
    h.invokeImpl = async () => {
      h.liveStatuses.set("b1", "verified");
      h.liveStatuses.set("b2", "disputed");
    };
    const out = await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(h.createdOtters[0].type).toBe("night-reviewer");
    expect(h.contextSets[0].key).toBe(NIGHT_REVIEW_RANGE_CONTEXT_KEY);
    expect(JSON.parse(h.contextSets[0].value)).toEqual({ after: DEFAULT_AFTER, through: NOW.toISOString() });
    expect(h.completes).toHaveLength(1);
    const changeset = JSON.parse(h.completes[0].json);
    expect(changeset.changes).toEqual([
      { id: "b1", to: "verified" },
      { id: "b2", to: "disputed" },
    ]);
    expect(h.entries.filter((e) => e !== "invoke")).toHaveLength(2);
    expect(h.matters).toHaveLength(1);
    expect(h.matters[0].initialState).toBe("WAITING_PARTNER");
    expect(JSON.parse(String(h.matters[0].payload)).changes).toHaveLength(2);
    expect(out.matterAnchor).toMatch(/^M-/);
    expect(h.dissolved).toEqual(["otter-1"]);
  });

  it("区间全集含非 recorded（现场即时 supersede）：不入待审清单，但入变更集审计", async () => {
    const h = makeHarness();
    h.liveStatuses = new Map([["b1", "recorded"], ["b2", "superseded"]]);
    h.invokeImpl = async () => { h.liveStatuses.set("b1", "verified"); };
    const out = await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(out.reviewed).toBe(1); // 只审了 b1
    const changeset = JSON.parse(h.completes[0].json);
    expect(changeset.changes).toEqual([
      { id: "b1", to: "verified" },
      { id: "b2", to: "superseded" }, // 全集审计：即时 supersede 也入册
    ]);
  });

  it("未全量处置（recorded 残留）：recordFailure 不 complete，错误上抛，獭仍解散", async () => {
    const h = makeHarness();
    h.invokeImpl = async () => { h.liveStatuses.set("b1", "verified"); /* b2 残留 */ };
    await expect(h.orch.execute({ conversationId: CONV, now: NOW })).rejects.toThrow("未全量处置");
    expect(h.completes).toHaveLength(0);
    expect(h.failures).toEqual([{ key: REVIEW_KEY, after: DEFAULT_AFTER, through: NOW.toISOString() }]);
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
});

describe("NightReviewOrchestrator（审-1946 首轮发现修复）", () => {
  it("发现 3a：首轮部分迁移后失败 → 重跑变更集含上轮已迁移条目（审计不丢）", async () => {
    const h = makeHarness();
    // 第一轮：b1 迁移成功后 invoke 抛错
    h.invokeImpl = async () => {
      h.liveStatuses.set("b1", "verified");
      throw new Error("turn failed after partial migrations");
    };
    await expect(h.orch.execute({ conversationId: CONV, now: NOW })).rejects.toThrow("turn failed");
    expect(h.failures).toHaveLength(1);

    // 第二轮（失败区间重跑）：b1 已 verified 不再待审，b2 审后迁移
    h.invokeImpl = async () => { h.liveStatuses.set("b2", "disputed"); };
    h.claimResult = {
      settled: false, resultJson: null, failures: 1,
      failingRange: { after: DEFAULT_AFTER, through: NOW.toISOString() },
    };
    const out = await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(out.reviewed).toBe(1); // 只审 b2
    expect(out.changes).toEqual([
      { id: "b1", to: "verified" }, // 上轮已迁移的仍在变更集（审计完整）
      { id: "b2", to: "disputed" },
    ]);
    // fyi 与否决锚照发
    expect(h.matters).toHaveLength(1);
    expect(h.entries.some((e) => e.includes("夜间审视完成"))).toBe(true);
  });

  it("发现 3b：首轮全部迁移后崩溃 → 重跑（无待审）正确 complete 全集 + 补发 fyi", async () => {
    const h = makeHarness();
    h.invokeImpl = async () => {
      h.liveStatuses.set("b1", "verified");
      h.liveStatuses.set("b2", "disputed");
      throw new Error("crash after all migrations");
    };
    await expect(h.orch.execute({ conversationId: CONV, now: NOW })).rejects.toThrow("crash after all");

    // 重跑：全集非空但无 recorded → 不召唤獭，直接按全集终态 settle + fyi
    h.invokeImpl = undefined;
    h.claimResult = {
      settled: false, resultJson: null, failures: 1,
      failingRange: { after: DEFAULT_AFTER, through: NOW.toISOString() },
    };
    const out = await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(h.createdOtters).toHaveLength(1); // 只有第一轮召唤过
    expect(out.changes).toEqual([
      { id: "b1", to: "verified" },
      { id: "b2", to: "disputed" },
    ]);
    expect(h.completes).toHaveLength(1);
    expect(h.matters).toHaveLength(1);
  });

  it("发现 4：fyi 阶段失败 → recordFailure（未 settle 可记）→ 重跑补发且 matter 查重复用", async () => {
    const h = makeHarness();
    h.invokeImpl = async () => {
      h.liveStatuses.set("b1", "verified");
      h.liveStatuses.set("b2", "disputed");
    };
    // 第一轮：report 阶段（完成 entry 写入）失败——complete 未发生
    h.entryImpl = async (body: string) => {
      if (body.includes("夜间审视完成")) throw new Error("entry write failed");
      h.entries.push(body);
    };
    await expect(h.orch.execute({ conversationId: CONV, now: NOW })).rejects.toThrow("entry write failed");
    expect(h.completes).toHaveLength(0);
    expect(h.failures).toHaveLength(1); // 未 settle，recordFailure 成功记账

    // 第二轮：无待审（全部已迁移）→ 补发路径；matter 已在第一轮登记过 → 查重复用不重复登记
    h.entryImpl = undefined;
    h.existingMatters = [{ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", title: `夜间审视 ${DATE}：2 条 belief 迁移待过目` }];
    h.claimResult = {
      settled: false, resultJson: null, failures: 1,
      failingRange: { after: DEFAULT_AFTER, through: NOW.toISOString() },
    };
    const out = await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(h.completes).toHaveLength(1); // 重跑补齐 settle
    expect(h.matters).toHaveLength(1); // 第一轮登记的那次（第二轮查重复用，不新增）
    expect(out.matterAnchor).toBe("M-aaaaaaaa");
    expect(h.entries.some((e) => e.includes("夜间审视完成"))).toBe(true); // fyi 补发成功
  });

  it("发现 5：召唤后 context 写入失败 → recordFailure + 解散已创建獭 + 上抛", async () => {
    const h = makeHarness();
    h.contextSetImpl = async () => { throw new Error("context store unavailable"); };
    await expect(h.orch.execute({ conversationId: CONV, now: NOW })).rejects.toThrow("context store unavailable");
    expect(h.createdOtters).toHaveLength(1);
    expect(h.failures).toHaveLength(1); // 记账不漏
    expect(h.dissolved).toEqual(["otter-1"]); // 獭解散不漏
  });

  it("发现 5：CreateOtter 自身失败 → recordFailure（无獭可解散）", async () => {
    const h = makeHarness();
    h.createOtterImpl = async () => { throw new Error("otter spawn failed"); };
    await expect(h.orch.execute({ conversationId: CONV, now: NOW })).rejects.toThrow("otter spawn failed");
    expect(h.failures).toHaveLength(1);
    expect(h.dissolved).toHaveLength(0); // 无獭产生，无需解散
  });

  it("发现 5：dissolve 失败 → healing 上报（孤儿受限写者可见）", async () => {
    const h = makeHarness();
    h.invokeImpl = async () => {
      h.liveStatuses.set("b1", "verified");
      h.liveStatuses.set("b2", "disputed");
    };
    h.dissolveImpl = async () => { throw new Error("dissolve blocked by lock"); };
    const out = await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(out.changes).toHaveLength(2); // 主流程不受 dissolve 失败影响
    const dissolveHealing = h.healings.find((e) => String(e.description).includes("解散失败"));
    expect(dissolveHealing).toBeDefined();
    expect(String(dissolveHealing?.suggestion)).toContain("手动解散");
  });

  it("发现 7：第 3 次失败（recordFailure 返回 shouldSkip）→ 当次 healing + skipped 返回，不上抛", async () => {
    const h = makeHarness();
    h.invokeImpl = async () => { throw new Error("third consecutive failure"); };
    h.failureOutcome = { failures: 3, shouldSkip: true };
    const out = await h.orch.execute({ conversationId: CONV, now: NOW }); // 不 rejects
    expect(out.skipped).toBe(true);
    expect(h.healings).toHaveLength(1);
    expect(String(h.healings[0].description)).toContain("没审视成");
    expect(h.failures).toHaveLength(1); // 当次只记一笔
    expect(h.dissolved).toEqual(["otter-1"]);
  });
  it("发现 12：无待审的补审计路径失败 → recordFailureOrSkip 统一治理（不直上抛熔断）", async () => {
    const h = makeHarness();
    // 首轮全部迁移后崩溃（pending=0 的补审计重跑场景）
    h.invokeImpl = async () => {
      h.liveStatuses.set("b1", "verified");
      h.liveStatuses.set("b2", "disputed");
      throw new Error("crash after all");
    };
    await expect(h.orch.execute({ conversationId: CONV, now: NOW })).rejects.toThrow("crash after all");
    // 重跑：补发再次失败（完成 entry 挂）
    h.invokeImpl = undefined;
    h.claimResult = {
      settled: false, resultJson: null, failures: 1,
      failingRange: { after: DEFAULT_AFTER, through: NOW.toISOString() },
    };
    h.entryImpl = async (body: string) => {
      if (body.includes("夜间审视完成")) throw new Error("report failed again");
      h.entries.push(body);
    };
    // 不召唤獭（无待审）但失败记账必须发生——修复前 failures 恒 0 直上抛
    await expect(h.orch.execute({ conversationId: CONV, now: NOW })).rejects.toThrow("report failed again");
    expect(h.createdOtters).toHaveLength(1); // 只有首轮召唤
    expect(h.failures).toHaveLength(2); // 首轮 + 补发失败各一笔
    expect(h.completes).toHaveLength(0);
  });

  it("发现 17：matter 查重窗口扩到 1000（超默认 50 条窗口的重复登记防护）", async () => {
    const h = makeHarness();
    h.invokeImpl = async () => {
      h.liveStatuses.set("b1", "verified");
      h.liveStatuses.set("b2", "disputed");
    };
    // 首轮登记成功后，同对话灌 60 条更新 matter——旧夜审 matter 落在默认 50 窗口外
    h.existingMatters = Array.from({ length: 60 }, (_, i) => ({
      id: `noise-${i}`,
      title: `其他事项 ${i}`,
    }));
    h.existingMatters.push({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", title: `夜间审视 ${DATE}：2 条 belief 迁移待过目` });
    const out = await h.orch.execute({ conversationId: CONV, now: NOW });
    expect(out.matterAnchor).toBe("M-aaaaaaaa"); // 查重命中（窗口 1000 覆盖），不重复登记
    expect(h.matters).toHaveLength(0);
  });
});
