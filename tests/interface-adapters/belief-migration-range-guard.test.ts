/**
 * belief 三迁移工具快照范围校验单测。
 *
 * 钉住 fail-closed 语义（v4 「出处 ID 存在且在当日快照范围内」）：
 * - 獭 context 无 night_review_range → 拒（非夜审编排召唤的獭无从获得迁移权）
 * - 范围档案损坏（非 JSON）→ 拒
 * - 目标条目不存在 → 拒
 * - createdAt 缺失 / 超出闭区间 → 拒
 * - 范围内 → 放行（verify/reject 走 transitionBelief、supersede 走 markBeliefExpired）
 */
import { describe, it, expect } from "vitest";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import { NIGHT_REVIEW_RANGE_CONTEXT_KEY } from "@entities/memory/consolidation-state";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";

const RANGE = { after: "2026-11-18T00:00:00.000Z", through: "2026-11-18T16:00:00.000Z" };

interface Harness {
  ctx: ToolContext;
  transitionCalls: Array<{ entryId: string; to: string }>;
  expireCalls: string[];
}

function makeHarness(opts: {
  rangeRaw?: string | null;
  target?: { id: string; createdAt?: string } | null;
}): Harness {
  const transitionCalls: Array<{ entryId: string; to: string }> = [];
  const expireCalls: string[] = [];
  const contextStore: Record<string, string> = {};
  if (opts.rangeRaw !== undefined && opts.rangeRaw !== null) {
    contextStore[NIGHT_REVIEW_RANGE_CONTEXT_KEY] = opts.rangeRaw;
  }
  const client = {
    memory: {
      getById: async (id: string) => opts.target && opts.target.id === id ? opts.target : null,
      transitionBelief: async (p: { entryId: string; to: string }) => { transitionCalls.push(p); return { ok: true }; },
      markBeliefExpired: async (id: string) => { expireCalls.push(id); return { ok: true }; },
    },
    context: {
      get: async (_otterId: string, key?: string) => (key ? (contextStore[key] !== undefined ? { [key]: contextStore[key] } : {}) : { ...contextStore }),
    },
  } as unknown as OtterToolClient;
  return { ctx: { client, otterId: "nr-1", conversationId: "conv-1", currentMessageId: "m-1" }, transitionCalls, expireCalls };
}

function getTool(ctx: ToolContext, name: string) {
  const tool = createTools(ctx).find((t) => t.name === name);
  if (!tool) throw new Error(`${name} tool not registered`);
  return tool;
}

async function run(ctx: ToolContext, name: string, entryId: string) {
  const result = await getTool(ctx, name).execute("tc-1", { entry_id: entryId });
  const text = (result as { content: Array<{ type: string; text: string }>; isError?: boolean });
  return { isError: text.isError === true, body: text.content[0].text };
}

const IN_RANGE_TARGET = { id: "b1", createdAt: "2026-11-18T08:30:00.000Z" };

describe("belief 三迁移工具快照范围校验（P2b2）", () => {
  it("无范围档（非夜审编排召唤）→ fail-closed 拒，不触达迁移", async () => {
    const h = makeHarness({ rangeRaw: null, target: IN_RANGE_TARGET });
    const r = await run(h.ctx, "belief_verify", "b1");
    expect(r.isError).toBe(true);
    expect(r.body).toContain("无快照范围");
    expect(h.transitionCalls).toHaveLength(0);
  });

  it("范围档案损坏（非 JSON）→ 拒", async () => {
    const h = makeHarness({ rangeRaw: "not-json", target: IN_RANGE_TARGET });
    const r = await run(h.ctx, "belief_verify", "b1");
    expect(r.isError).toBe(true);
    expect(r.body).toContain("损坏");
  });

  it("语义损坏（合法 JSON 但无 after/through）→ 拒（NaN 比较恒 false 不得放行）", async () => {
    const h = makeHarness({ rangeRaw: JSON.stringify({}), target: { id: "b-any", createdAt: "2020-01-01T00:00:00.000Z" } });
    const r = await run(h.ctx, "belief_verify", "b-any");
    expect(r.isError).toBe(true);
    expect(r.body).toContain("语义非法");
    expect(h.transitionCalls).toHaveLength(0);
  });

  it("语义损坏（字段非法时间字符串）→ 拒", async () => {
    const h = makeHarness({
      rangeRaw: JSON.stringify({ after: "yesterday", through: "tomorrow" }),
      target: IN_RANGE_TARGET,
    });
    const r = await run(h.ctx, "belief_reject", "b1");
    expect(r.isError).toBe(true);
    expect(r.body).toContain("语义非法");
    expect(h.transitionCalls).toHaveLength(0);
  });

  it("语义损坏（倒挂区间 after > through）→ 拒", async () => {
    const h = makeHarness({
      rangeRaw: JSON.stringify({ after: RANGE.through, through: RANGE.after }),
      target: IN_RANGE_TARGET,
    });
    const r = await run(h.ctx, "belief_supersede", "b1");
    expect(r.isError).toBe(true);
    expect(h.expireCalls).toHaveLength(0);
  });

  it("目标条目不存在 → 拒", async () => {
    const h = makeHarness({ rangeRaw: JSON.stringify(RANGE), target: null });
    const r = await run(h.ctx, "belief_verify", "absent");
    expect(r.isError).toBe(true);
    expect(r.body).toContain("不存在");
  });

  it("createdAt 早于区间下界 → 拒（历史条目不可波及）", async () => {
    const h = makeHarness({
      rangeRaw: JSON.stringify(RANGE),
      target: { id: "b-old", createdAt: "2026-11-17T23:59:59.999Z" },
    });
    const r = await run(h.ctx, "belief_reject", "b-old");
    expect(r.isError).toBe(true);
    expect(r.body).toContain("不在快照范围");
    expect(h.transitionCalls).toHaveLength(0);
  });

  it("createdAt 晚于区间上界 → 拒", async () => {
    const h = makeHarness({
      rangeRaw: JSON.stringify(RANGE),
      target: { id: "b-new", createdAt: "2026-11-18T16:00:00.001Z" },
    });
    const r = await run(h.ctx, "belief_supersede", "b-new");
    expect(r.isError).toBe(true);
    expect(h.expireCalls).toHaveLength(0);
  });

  it("createdAt 缺失 → fail-closed 拒（装配未回填不仓促放行）", async () => {
    const h = makeHarness({ rangeRaw: JSON.stringify(RANGE), target: { id: "b1" } });
    const r = await run(h.ctx, "belief_verify", "b1");
    expect(r.isError).toBe(true);
    expect(r.body).toContain("缺失");
  });

  it("闭区间边界（after/through 当刻）→ 放行", async () => {
    const lower = makeHarness({ rangeRaw: JSON.stringify(RANGE), target: { id: "b-lo", createdAt: RANGE.after } });
    const lo = await run(lower.ctx, "belief_verify", "b-lo");
    expect(lo.isError).toBe(false);
    expect(lower.transitionCalls).toEqual([{ entryId: "b-lo", to: "verified" }]);

    const upper = makeHarness({ rangeRaw: JSON.stringify(RANGE), target: { id: "b-hi", createdAt: RANGE.through } });
    const hi = await run(upper.ctx, "belief_reject", "b-hi");
    expect(hi.isError).toBe(false);
    expect(upper.transitionCalls).toEqual([{ entryId: "b-hi", to: "disputed" }]);
  });

  it("范围内 supersede → markBeliefExpired（不建边不删条目）", async () => {
    const h = makeHarness({ rangeRaw: JSON.stringify(RANGE), target: IN_RANGE_TARGET });
    const r = await run(h.ctx, "belief_supersede", "b1");
    expect(r.isError).toBe(false);
    expect(h.expireCalls).toEqual(["b1"]);
    expect(h.transitionCalls).toHaveLength(0);
  });
});

describe("belief_dispute（搭档否决打回——夜审编排阶段补全）", () => {
  it("无快照范围约束：直接迁 disputed（打回对象可为任何历史 belief）", async () => {
    const transitionCalls: Array<{ entryId: string; to: string }> = [];
    const client = {
      memory: {
        transitionBelief: async (p: { entryId: string; to: string }) => {
          transitionCalls.push(p);
          return { entryId: p.entryId, from: "verified", to: p.to };
        },
      },
      // context.get 返回空（无范围档）——dispute 不受快照约束，照常执行
      context: { get: async () => ({}) },
    } as unknown as OtterToolClient;
    const ctx = { client, otterId: "big-1", conversationId: "conv-1", currentMessageId: "m-1" } as ToolContext;
    const r = await run(ctx, "belief_dispute", "old-belief-2020");
    expect(r.isError).toBe(false);
    expect(transitionCalls).toEqual([{ entryId: "old-belief-2020", to: "disputed" }]);
  });

  it("迁移非法（superseded 终态）→ usecase 层错误回显", async () => {
    const client = {
      memory: {
        transitionBelief: async () => { throw new Error("belief 状态迁移非法：superseded → disputed"); },
      },
      context: { get: async () => ({}) },
    } as unknown as OtterToolClient;
    const ctx = { client, otterId: "big-1", conversationId: "conv-1", currentMessageId: "m-1" } as ToolContext;
    const r = await run(ctx, "belief_dispute", "b-final");
    expect(r.isError).toBe(true);
    expect(r.body).toContain("迁移非法");
  });
});
