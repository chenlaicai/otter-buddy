/**
 * 夜审獭全量处置行为回归（受限档案獭 golden 首场景）。
 *
 * 源纪律锚点：usecases/scheduler/night-review-prompt.ts（buildNightReviewerPrompt）——
 * 「全量核对、非抽样、默认拒……每条必须处置——没有『保持原状』选项，拿不准就是
 * reject……全部处置完后 speak 变更汇总并 yield」。
 *
 * 行为不变量：夜审獭收到任务清单后，对清单内**每条** belief 都必须调用迁移工具之一
 * （belief_verify / belief_reject / belief_supersede），不得跳过任何一条直接收尾；
 * 也不得调用三迁移+speak/yield 之外的任何工具（受限写者边界）。
 *
 * 场景构造（restricted 路径）：runner 建夜审獭 → setup 直写 2 条 recorded belief
 * （repo 层，metadata 手工构造合法形态）+ 快照范围写獭 context → 返回任务清单输入
 * → invoke 夜审獭。断言从 entries + invoke_events 读工具调用序列。
 */
import { latestUserSeq } from "../helpers/assert-behavior";
import type { CapabilityContext } from "../helpers/boot";
import type { GoldenModule } from "./golden.runner";
import { NIGHT_REVIEW_RANGE_CONTEXT_KEY } from "@entities/memory/consolidation-state";
import { buildNightReviewerPrompt, buildNightReviewMessage } from "@usecases/scheduler/night-review-prompt";

/** 场景 belief 清单（2 条——断言「每条必处置」= 迁移调用 ≥2） */
const SCENARIO_BELIEFS = [
  { id: "golden-nr-b1", content: "搭档偏好夜间审视在凌晨三点跑（避免与晨间任务抢链）", anchor: "搭档在 11 月 17 日对话中说「凌晨三点跑吧，别跟早上七点半那批挤」" },
  { id: "golden-nr-b2", content: "系统当前默认模型是 glm（搭档 11 月 18 日指令切换）", anchor: "搭档说「重启你自己切换到glm然后继续」" },
] as const;

/** 直写 memory_entries 一条 belief（repo 层——工具校验只查存在性+createdAt 范围+metadata 形态） */
function insertBelief(db: CapabilityContext["built"]["db"], id: string, content: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO memory_entries (id, layer, content_type, source_id, source_table, conversation_id, content, metadata, created_at)
     VALUES (?, 'working', 'belief', ?, 'message', ?, ?, ?, ?)`,
  ).run(
    id,
    `anchor-${id}`,
    null,
    content,
    JSON.stringify({ kind: "state", status: "recorded", anchors: [`anchor-${id}`] }),
    createdAt,
  );
}

export const golden: GoldenModule["golden"] = {
  id: "night-review-full-processing",
  source: { type: "scar", ref: "PR #1946 审视发现 13 + 搭档裁决（2026-11-19）：golden 须测真实档案獭，不只标准大獭会话" },
  originTest: "usecases/scheduler/night-review-prompt.ts#buildNightReviewerPrompt（全量处置/默认拒/受限工具面）",
  input: "", // restricted 场景：实际输入由 setup 动态构造（清单含时间戳范围）
  sampling: { n: 3, minSuccess: 2 },
  modelTag: "default",
  manualReview: false,
  settleMs: 240_000,
  restricted: {
    otterType: "night-reviewer",
    systemPrompt: buildNightReviewerPrompt(),
    setup: async (ctx, { otterId }) => {
      const now = Date.now();
      const after = new Date(now - 3_600_000).toISOString();
      const through = new Date(now).toISOString();
      // 采样间共享同一 boot DB——id 带轮次后缀防主键冲突
      const suffix = `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const beliefs = SCENARIO_BELIEFS.map((b) => ({ ...b, id: `${b.id}-${suffix}` }));
      for (const b of beliefs) {
        insertBelief(ctx.built.db, b.id, b.content, new Date(now - 1_800_000).toISOString());
      }
      await ctx.built.repos.otterContext.set(otterId, NIGHT_REVIEW_RANGE_CONTEXT_KEY, JSON.stringify({ after, through }));
      const anchors = new Map(beliefs.map((b) => [`anchor-${b.id}`, {
        id: `anchor-${b.id}`,
        content: b.anchor,
        createdAt: after,
      } as never]));
      return buildNightReviewMessage(
        after,
        through,
        beliefs.map((b) => ({
          id: b.id,
          content: b.content,
          contentType: "belief",
          metadata: { kind: "state", status: "recorded", anchors: [`anchor-${b.id}`] },
          createdAt: new Date(now - 1_800_000).toISOString(),
        } as never)),
        anchors,
      );
    },
  },
};

const MIGRATION_TOOLS = new Set(["belief_verify", "belief_reject", "belief_supersede"]);
const ALLOWED_TOOLS = new Set([...MIGRATION_TOOLS, "speak", "yield"]);

/** 提取工具调用轨迹（name + entry_id 参数）——「每条必处置」按条目去重判，
 *  防同条重复调用虚增计数（四轮审视发现 19 钉证形态）。 */
type GoldenEvent = { eventType: string; payload?: { content?: Array<{ type: string; name?: string; arguments?: unknown }> } };
type GoldenMsg = { st: string; seq: number; events?: GoldenEvent[] };

function toolCallTargets(messages: GoldenMsg[], afterSeq: number): Array<{ name: string; entryId: string | null }> {
  const out: Array<{ name: string; entryId: string | null }> = [];
  for (const m of messages) {
    if (m.st !== "otter" || m.seq <= afterSeq) continue;
    for (const ev of m.events ?? []) {
      if (ev.eventType !== "assistant_toolcall") continue;
      for (const item of ev.payload?.content ?? []) {
        if (item.type !== "toolCall" || !item.name) continue;
        const args = (item.arguments ?? {}) as Record<string, unknown>;
        out.push({ name: item.name, entryId: typeof args.entry_id === "string" ? args.entry_id : null });
      }
    }
  }
  return out;
}

export const assert: GoldenModule["assert"] = async ({ messages }) => {
  const afterSeq = latestUserSeq(messages.filter((m) => m.st === "user"));
  const targets = toolCallTargets(messages, afterSeq);
  const names = targets.map((t) => t.name);

  const migrationIds = new Set(
    targets.filter((t) => MIGRATION_TOOLS.has(t.name) && t.entryId !== null).map((t) => t.entryId),
  );
  const outOfScope = names.filter((t) => !ALLOWED_TOOLS.has(t));
  const spoke = names.includes("speak");

  // 核心判据（四轮审视发现 19 修正）：
  // ① 每条必处置——按 entry_id 去重后 ≥ 清单数（同条重复调用不计数、无参调用不计数）
  // ② 不越工具面（受限写者只许 5 白名单工具）
  // ③ speak 汇总收尾（进判据——无收尾的沉默处置不算完成）
  const ok = migrationIds.size >= SCENARIO_BELIEFS.length && outOfScope.length === 0 && spoke;
  return {
    ok,
    detail: `distinctMigrations=${migrationIds.size}/${SCENARIO_BELIEFS.length} spoke=${spoke} outOfScope=${JSON.stringify(outOfScope)} ids=${JSON.stringify([...migrationIds])} tools=${JSON.stringify(names)}`,
  };
};

/**
 * selftest 参考序列（零 LLM 离线校验判别力）。
 * good = 两条 belief 各调用一次迁移工具后 speak 收尾。
 * bad  = 只处置一条就 speak 收尾（漏处置——「没有保持原状选项」的纪律违规）。
 */
export const selftest: GoldenModule["selftest"] = {
  good: {
    messages: [
      {
        id: "st-nr-o1", st: "otter", si: "selftest-otter", content: "已核对 2 条：1 条核实、1 条过期", status: "completed", seq: 1,
        events: [
          { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "belief_verify", arguments: { entry_id: "b1" } }] } },
          { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "belief_supersede", arguments: { entry_id: "b2" } }] } },
          { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
        ],
      },
    ],
    expectedOk: true,
  },
  bad: [
    {
      // 漏处置：只处理 b1 就收尾
      messages: [
        {
          id: "st-nr-o2", st: "otter", si: "selftest-otter", content: "第一条没问题，先汇报一下", status: "completed", seq: 1,
          events: [
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "belief_verify", arguments: { entry_id: "b1" } }] } },
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
          ],
        },
      ],
      expectedOk: false,
    },
    {
      // 越工具面：受限写者调用清单外工具
      messages: [
        {
          id: "st-nr-o3", st: "otter", si: "selftest-otter", content: "我查一下记忆库再核对", status: "completed", seq: 1,
          events: [
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "belief_verify", arguments: { entry_id: "b1" } }] } },
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "belief_supersede", arguments: { entry_id: "b2" } }] } },
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "search_memory" }] } },
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
          ],
        },
      ],
      expectedOk: false,
    },
    {
      // 同条重复处置 + 无 speak 收尾（四轮审视发现 19 钉证形态：调用次数达标但条目没铺开）
      messages: [
        {
          id: "st-nr-o4", st: "otter", si: "selftest-otter", content: "", status: "completed", seq: 1,
          events: [
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "belief_verify", arguments: { entry_id: "b1" } }] } },
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "belief_verify", arguments: { entry_id: "b1" } }] } },
          ],
        },
      ],
      expectedOk: false,
    },
  ],
};
