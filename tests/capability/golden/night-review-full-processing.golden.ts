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
        // createdAt 取 now（快照闭区间上界内）：保证每轮 setup 行恒新于上一轮 selftest
        // factory 行——assert 反查「最新 2 条」在采样轮命中本轮清单、在 selftest 轮命中工厂行
        insertBelief(ctx.built.db, b.id, b.content, new Date(now).toISOString());
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
          createdAt: new Date(now).toISOString(),
        } as never)),
        anchors,
      );
    },
  },
};

const MIGRATION_TOOLS = new Set(["belief_verify", "belief_reject", "belief_supersede"]);
const ALLOWED_TOOLS = new Set([...MIGRATION_TOOLS, "speak", "yield"]);

/** 提取工具调用轨迹（name + entry_id 参数）——「每条必处置」按条目去重判，
 * 防同条重复调用虚增计数（四轮审视钉证形态）。 */
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

/** 反查本轮清单 id：setup 每采样轮直写 2 条（created_at 单调递增），取最新 N 条即本轮。
 *  断言与清单精确比对（第五轮审视修正：任意两个不同 id 不算数——必须正是清单内的条目）。 */
function loadScenarioIds(db: { prepare: (sql: string) => { all: () => Array<{ id: string }> } }): Set<string> {
  const rows = db.prepare(
    "SELECT id FROM memory_entries WHERE id LIKE 'golden-nr-b%' AND content_type = 'belief' ORDER BY created_at DESC, id DESC LIMIT 2",
  ).all();
  return new Set(rows.map((r) => r.id));
}

export const assert: GoldenModule["assert"] = async ({ ctx, messages }) => {
  const afterSeq = latestUserSeq(messages.filter((m) => m.st === "user"));
  const targets = toolCallTargets(messages, afterSeq);
  const names = targets.map((t) => t.name);

  const migrationIds = new Set(
    targets.filter((t) => MIGRATION_TOOLS.has(t.name) && t.entryId !== null).map((t) => t.entryId as string),
  );
  const outOfScope = names.filter((t) => !ALLOWED_TOOLS.has(t));
  const spoke = names.includes("speak");
  const scenarioIds = loadScenarioIds(ctx.built.db);
  // 清单内每条都被处置（全覆盖）；处置目标不出清单（幻觉 id / 乱处置别的条目不算数）
  const uncovered = [...scenarioIds].filter((id) => !migrationIds.has(id));
  const offList = [...migrationIds].filter((id) => !scenarioIds.has(id));

  // 核心判据（四轮发现 19 + 五轮清单外对抗修正）：
  // ① 清单反查精确比对——scenarioIds 全覆盖且无清单外处置（同条重复/无参/幻觉 id 均不达标）
  // ② 不越工具面（受限写者只许 5 白名单工具）
  // ③ speak 汇总收尾（无收尾的沉默处置不算完成）
  // ④ 清单行不可得（DB 异常/残留污染）→ fail-closed 拒，不放行
  const ok = scenarioIds.size === SCENARIO_BELIEFS.length
    && uncovered.length === 0 && offList.length === 0
    && outOfScope.length === 0 && spoke;
  return {
    ok,
    detail: `scenario=${scenarioIds.size} covered=${scenarioIds.size - uncovered.length}/${scenarioIds.size} offList=${JSON.stringify(offList)} spoke=${spoke} outOfScope=${JSON.stringify(outOfScope)} tools=${JSON.stringify(names)}`,
  };
};

/**
 * selftest 参考序列（零 LLM 离线校验判别力）。
 * good = 两条 belief 各调用一次迁移工具后 speak 收尾。
 * bad  = 只处置一条就 speak 收尾（漏处置——「没有保持原状选项」的纪律违规）。
 */
export const selftest: GoldenModule["selftest"] = async (ctx) => {
  // DB 依赖场景（factory 形态）：断言反查清单行——先写 2 条（st-b1/st-b2）作本轮清单，
  // 轨迹的 entry_id 与之精确比对。第五轮清单外对抗轨迹（ghost id）也在此钉证。
  insertBelief(ctx.built.db, "golden-nr-bst1", "st 清单第一条", new Date().toISOString());
  insertBelief(ctx.built.db, "golden-nr-bst2", "st 清单第二条", new Date().toISOString());
  return {
    good: {
      messages: [
        {
          id: "st-nr-o1", st: "otter", si: "selftest-otter", content: "已核对 2 条：1 条核实、1 条过期", status: "completed", seq: 1,
          events: [
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "belief_verify", arguments: { entry_id: "golden-nr-bst1" } }] } },
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "belief_supersede", arguments: { entry_id: "golden-nr-bst2" } }] } },
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
          ],
        },
      ],
      expectedOk: true,
    },
    bad: [
      {
        // 漏处置：清单第二条没碰
        messages: [
          {
            id: "st-nr-o2", st: "otter", si: "selftest-otter", content: "第一条没问题，先汇报一下", status: "completed", seq: 1,
            events: [
              { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "belief_verify", arguments: { entry_id: "golden-nr-bst1" } }] } },
              { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
            ],
          },
        ],
        expectedOk: false,
      },
      {
        // 同条重复处置 + 无 speak 收尾（四轮审视钉证形态）
        messages: [
          {
            id: "st-nr-o3", st: "otter", si: "selftest-otter", content: "", status: "completed", seq: 1,
            events: [
              { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "belief_verify", arguments: { entry_id: "golden-nr-bst1" } }] } },
              { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "belief_verify", arguments: { entry_id: "golden-nr-bst1" } }] } },
            ],
          },
        ],
        expectedOk: false,
      },
      {
        // 清单外 id 对抗（五轮审视钉证形态）：处置了两个不存在的幻觉条目 + 收尾——
        // 次数与去重都达标，但清单内条目实际全部漏审，必须判 !ok
        messages: [
          {
            id: "st-nr-o4", st: "otter", si: "selftest-otter", content: "两条都核对完了", status: "completed", seq: 1,
            events: [
              { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "belief_verify", arguments: { entry_id: "ghost-1" } }] } },
              { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "belief_reject", arguments: { entry_id: "ghost-2" } }] } },
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
            id: "st-nr-o5", st: "otter", si: "selftest-otter", content: "我查一下记忆库再核对", status: "completed", seq: 1,
            events: [
              { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "belief_verify", arguments: { entry_id: "golden-nr-bst1" } }] } },
              { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "belief_supersede", arguments: { entry_id: "golden-nr-bst2" } }] } },
              { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "search_memory" }] } },
              { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
            ],
          },
        ],
        expectedOk: false,
      },
    ],
  };
};
