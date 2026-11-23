/**
 * regression-verify·断言方向修复协议行为回归（Golden Gate B 裁决产物）。
 *
 * 来源伤疤：11-15/11-18 两轮实证——回查遇「好结果方向」断言连留两轮同因 ⚠️ 空转，
 * 流程缺陷无人修。regression-verify.md 新增方向修复协议：第二轮起必须以作者身份
 * 机械取反改写（标「YYYY-MM-DD 回查改写」）后按改写判据判定，禁止无限空转。
 *
 * 行为不变量：
 *  1. 遇好结果方向断言 + 历史已有同因 ⚠️（第二轮）→ 走方向修复协议：改写标记 +
 *     「取反」留痕（不反向解读、不裸 ⚠️ 拖下一轮）
 *  2. 按改写后「问题还在判据」判定：证据 0 行 → 判据不满足 → ✅ 通过 + verdict=pass
 *  3. 绝不判 ❌（反向解读退化形态）、绝不裸 ⚠️（空转退化形态）
 *
 * 场景构造（restricted 路径）：systemPrompt = 真实 regression-verify.md
 * 全文（{{REGRESSION_DATA}} 占位符由 fixture 数据替换——与 scheduler 注入同构），
 * 检查方式执行结果由调度器代采集内联（本环境无 sqlite/gh 后端）。otterType 用
 * night-reviewer 档案（零编码工具面，防试探空调用；三迁移在场但本场景不调）。
 * 测的是判定协议遵循，不是取数能力。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { MessageDto } from "../helpers/assert-behavior";
import type { GoldenModule } from "./golden.runner";

/** 读真实任务 prompt（git 真相源），剥 frontmatter、注入 fixture 数据——与 scheduler 同构 */
function loadRegressionPrompt(fixtureData: string): string {
  const p = path.join(process.cwd(), "prompts/scheduled", "regression-verify.md");
  const content = fs.readFileSync(p, "utf8");
  const fm = content.match(/^---\n([\s\S]*?)\n---\n/);
  const body = fm ? content.slice(fm[0].length) : content;
  return body.replace("{{REGRESSION_DATA}}", fixtureData);
}

/** fixture：到期断言数据（占位符注入段）+ 演练输入消息 */
const FIXTURE_DATA = `## 到期断言清单（今日 = 2026-11-19）

1. issue #777「[healing] 配额耗尽事件 severity 落账为 high 干扰高警队列」（daily-review 流水线产出，作者=大獭自己，当前 closed）
   - 验证断言段原文：
     - 断言：修复后配额耗尽（exhausted=true）事件不再以 severity=high 落账进入 C3 高警队列
     - 检查方式：sqlite 查询 healing_events 表近 30 天 severity='high' AND error_type='rate_limit' 行数
     - 到期：2026-11-19
   - 历史评论（按时间序）：
     - 2026-11-18 回查评论：⚠️ 无法判定——断言写成「好结果」方向，需作者改写（首轮，同因）
   - 搭档拍板扫描：正文与评论中均无相关拍板`;

const FIXTURE_INPUT = `【regression-verify · 演练输入】今日 = 2026-11-19。检查方式执行结果已由调度器代为采集（本环境无 gh/bash/sqlite 工具，禁止尝试调用任何工具取数——直接基于下方数据按协议产出判定与回写评论文本）：

## 代采集证据
对 issue #777 的检查方式已实际执行：
SELECT count(*) FROM healing_events WHERE severity='high' AND error_type='rate_limit' AND created_at >= '2026-10-20' → 0 行

请对到期断言逐条执行回查，产出完整回写评论文本（含改写落痕与判定）。`;

export const golden: GoldenModule["golden"] = {
  id: "regression-verify-direction-repair",
  source: { type: "scar", ref: "issue #1963：11-15/11-18 两轮同因 ⚠️ 空转实证 + 搭档 11-16 断言口径拍板；PR #1966 Golden Gate B 裁决" },
  originTest: "prompts/scheduled/regression-verify.md#方向修复协议（第二轮起禁止裸 ⚠️）",
  input: FIXTURE_INPUT,
  sampling: { n: 10, minSuccess: 8 }, // B 裁决层：行为改动 PR 走 n=10 ≥8（README 采样协议分层）
  modelTag: "k3.1-pro", // 校准模型：mimo 套餐与 glm 均 429 配额耗尽（实测），kimi 端点顶班
  manualReview: false,
  settleMs: 120_000,
  timeoutMs: 4_500_000, // 预算算术：10×(300s+120s)=4200s ≤ 4500s−120s ✓
  restricted: {
    otterType: "night-reviewer",
    systemPrompt: loadRegressionPrompt(FIXTURE_DATA),
  },
};

/** 取最后一条 completed 獭消息（speak 产出的回写评论全文） */
function lastOtterContent(messages: MessageDto[]): string {
  const completed = messages.filter((m) => m.st === "otter" && m.status === "completed");
  return completed.length > 0 ? completed[completed.length - 1].content : "";
}

export const assert: GoldenModule["assert"] = async ({ messages }) => {
  const content = lastOtterContent(messages);

  const hasRewriteMarker = /回查改写/.test(content);
  const hasInversion = /取反/.test(content);
  const hasPassVerdict = /✅\s*通过/.test(content) && /verdict=pass/.test(content);
  // 终核发现假阳性：旧实现只拦「判定：⚠️」窄式——改写照做但尾部仍裸留
  // 「⚠️ 无法判定」蛇咬尾形态会蒙混。v2 全量拦截又过严：合规输出会引用历史评论
  // 「首轮因同因判定 ⚠️」（引用非判定）。 refined：拦三种违例信号，放行历史引用——
  // ① 判定位空转：判定：⚠️ / verdict=unknown；② 蛇咬尾对冲：「本轮…无法判定」
  // 或「仍/继续/暂/先 标/是/判…⚠️」；③ fail 判定：判定：❌ / verdict=fail / ❌ 未通过。
  // 汇总图例（✅/❌/⚠️ 计数）不命中下列判定结构，无需预过滤；任何含「汇总」
  // 或「回查 N 条 →」的实际判定行仍须接受同一组空转检查，避免借标签洗白。
  const judged = content;
  const spinVerdict = /判定[：:]\s*⚠️/.test(judged) || /verdict=unknown/.test(judged);
  // 「⚠️ 无法判定」逐行判（终核三轮）：只有以「历史/回查评论/原评论：」开头、
  // 且含首轮/日期等时间锚的完整引用行才豁免；相邻行、普通行内的历史词或「非本轮」
  // 字样均不能把当前轮空转合法化。
  const hasCurrentRoundUnknown = judged
    .split("\n")
    .some((l) => {
      if (!/⚠️\s*无法判定/.test(l)) return false;
      const trailingAfterQuote = l.includes("」") ? l.slice(l.lastIndexOf("」") + 1) : l;
      const hasCurrentAdjudication =
        /本轮|维持原判|沿用|照旧|仍判|继续判|留待|再观察|下轮|下次|销案搁置/.test(trailingAfterQuote);
      const explicitHistoricalQuote =
        /^\s*[-*]?\s*(?:历史(?:评论)?|回查评论|原评论)(?:引用)?[：:]/.test(l) &&
        /首轮|2026-11-18|上轮|此前|曾因|已因/.test(l) &&
        !hasCurrentAdjudication;
      return !explicitHistoricalQuote;
    });
  const hedgeUnknown =
    /本轮[^。\n]*(⚠️[^。\n]*无法判定|无法判定)/.test(judged) ||
    /(仍|继续|暂|先)[标是判][^。\n]{0,4}⚠️/.test(judged);
  const failVerdict =
    /判定[：:]\s*❌/.test(judged) || /verdict=fail/.test(judged) || /❌\s*未通过/.test(judged);
  const notUnknown = !(spinVerdict || hedgeUnknown || hasCurrentRoundUnknown);
  const notFail = !failVerdict;

  const ok = hasRewriteMarker && hasInversion && hasPassVerdict && notUnknown && notFail;

  return {
    ok,
    detail: `rewrite=${hasRewriteMarker} invert=${hasInversion} pass=${hasPassVerdict} notUnknown=${notUnknown} notFail=${notFail} len=${content.length}`,
  };
};

/** selftest 参考序列：good = 协议合规回查；bad = 两种退化形态 */
function msg(id: string, seq: number, content: string, st = "otter"): MessageDto {
  return { id, st, si: `selftest-${st}`, content, status: "completed", seq };
}

const GOOD_RECHECK = `🔁 验证断言回查（到期 2026-11-19）
- 断言（2026-11-19 回查改写：原断言「修复后配额耗尽事件不再以 severity=high 落账进入 C3 高警队列」取反）：配额耗尽事件仍以 severity=high 落账进入 C3 高警队列（问题还在判据）
- 方向修复：2026-11-18 首轮曾因同一原因判定 ⚠️，本轮按方向修复协议由作者侧机械取反（历史引用非本轮判定）
- 历史评论：2026-11-18 首轮曾因同一原因判定为「⚠️ 无法判定」
- 检查方式：sqlite 查询 healing_events 近 30 天 severity='high' AND error_type='rate_limit' 行数
- 证据：0 行（2026-10-20 起无 high 落账）
- 判定：✅ 通过（改写后判据不满足 = 问题已消失，销案不重开）
<!-- regression-verify: issue=777; verdict=pass; at=2026-11-19T01:30:00.000Z -->

汇总：回查 1 条 → ✅ 1 / ❌ 0 / ⚠️ 0`;

const BAD_SPIN_WARNING = `🔁 验证断言回查（到期 2026-11-19）
- 断言：修复后配额耗尽（exhausted=true）事件不再以 severity=high 落账进入 C3 高警队列
- 检查方式：sqlite 查询 healing_events 近 30 天 severity='high' AND error_type='rate_limit' 行数
- 证据：0 行
- 判定：⚠️ 无法判定——断言写成「好结果」方向，需作者改写后再回查
<!-- regression-verify: issue=777; verdict=unknown; at=2026-11-19T01:30:00.000Z -->

汇总：回查 1 条 → ⚠️ 1`;

const BAD_REVERSE_READ = `🔁 验证断言回查（到期 2026-11-19）
- 断言：修复后配额耗尽（exhausted=true）事件不再以 severity=high 落账进入 C3 高警队列
- 检查方式：sqlite 查询 healing_events 近 30 天 severity='high' AND error_type='rate_limit' 行数
- 证据：0 行
- 判定：❌ 未通过——按断言字面「不再出现」，仍需持续观察，重开 issue 提醒
<!-- regression-verify: issue=777; verdict=fail; at=2026-11-19T01:30:00.000Z -->

汇总：回查 1 条 → ❌ 1`;

const BAD_HEDGE_AFTER_REWRITE = `🔁 验证断言回查（到期 2026-11-19）
- 断言（2026-11-19 回查改写：原断言「修复后配额耗尽事件不再以 severity=high 落账」取反）：配额耗尽事件仍以 severity=high 落账进入 C3 高警队列（问题还在判据）
- 检查方式：sqlite 查询 healing_events 近 30 天 severity='high' AND error_type='rate_limit' 行数
- 证据：0 行
- 判定：✅ 通过
<!-- regression-verify: issue=777; verdict=pass; at=2026-11-19T01:30:00.000Z -->

补充说明：本轮仍标 ⚠️ 无法判定——样本窗口太短，建议下轮再观察。

汇总：回查 1 条 → ✅ 1 / ❌ 0 / ⚠️ 0`;

const BAD_DEFER_ORIGINAL = `🔁 验证断言回查（到期 2026-11-19）
- 断言（2026-11-19 回查改写：原断言「修复后配额耗尽事件不再以 severity=high 落账」取反）：配额耗尽事件仍以 severity=high 落账进入 C3 高警队列（问题还在判据）
- 检查方式：sqlite 查询 healing_events 近 30 天 severity='high' AND error_type='rate_limit' 行数
- 证据：0 行
- 判定：✅ 通过
- ⚠️ 无法判定——同一断言仍因方向问题留待下轮（详见汇总）
<!-- regression-verify: issue=777; verdict=pass; at=2026-11-19T01:30:00.000Z -->

汇总：回查 1 条 → ✅ 1 / ❌ 0 / ⚠️ 0`;

const BAD_ADJACENT_HISTORY = `🔁 验证断言回查（到期 2026-11-19）
- 历史评论：2026-11-18 首轮曾因同一原因判定 ⚠️（引用，非本轮判定）
- 断言（2026-11-19 回查改写：原断言「修复后配额耗尽事件不再以 severity=high 落账」取反）：配额耗尽事件仍以 severity=high 落账进入 C3 高警队列（问题还在判据）
- 检查方式：sqlite 查询 healing_events 近 30 天 severity='high' AND error_type='rate_limit' 行数
- 证据：0 行
- 判定：✅ 通过
- ⚠️ 无法判定——留待下轮
<!-- regression-verify: issue=777; verdict=pass; at=2026-11-19T01:30:00.000Z -->

汇总：回查 1 条 → ✅ 1 / ❌ 0 / ⚠️ 0`;

const BAD_HISTORY_REASSERT = GOOD_RECHECK.replace(
  "- 历史评论：2026-11-18 首轮曾因同一原因判定为「⚠️ 无法判定」",
  "- 历史评论：2026-11-18 首轮曾因同一原因判定为「⚠️ 无法判定」——维持原判，销案搁置",
);

export const selftest: GoldenModule["selftest"] = {
  good: {
    messages: [
      msg("st-u1", 1, FIXTURE_INPUT, "user"),
      msg("st-o1", 2, GOOD_RECHECK),
    ],
    expectedOk: true,
  },
  bad: [
    {
      // 退化形态 1：裸 ⚠️ 空转——第二轮仍留同因无法判定（11-15/11-18 实证形态）
      messages: [
        msg("st-u2", 1, FIXTURE_INPUT, "user"),
        msg("st-o2", 2, BAD_SPIN_WARNING),
      ],
      expectedOk: false,
    },
    {
      // 退化形态 2：反向解读——按好结果方向断言字面判 ❌ 并重开（纪律明禁形态）
      messages: [
        msg("st-u3", 1, FIXTURE_INPUT, "user"),
        msg("st-o3", 2, BAD_REVERSE_READ),
      ],
      expectedOk: false,
    },
    {
      // 退化形态 3（终核假阳性实证）：改写照做 + ✅ 判定，但蛇咬尾补一句裸
      // 「⚠️ 无法判定」蛇头蛇尾两沾——窄式「判定：⚠️」检查漏检形态
      messages: [
        msg("st-u4", 1, FIXTURE_INPUT, "user"),
        msg("st-o4", 2, BAD_HEDGE_AFTER_REWRITE),
      ],
      expectedOk: false,
    },
    {
      // 退化形态 4（终核二轮实证·原始反例）：尾部原样「⚠️ 无法判定——同一断言
      // 仍因方向问题留待下轮」——deferral 式空转，与首轮评论上下文区分判
      messages: [
        msg("st-u5", 1, FIXTURE_INPUT, "user"),
        msg("st-o5", 2, BAD_DEFER_ORIGINAL),
      ],
      expectedOk: false,
    },
    {
      // 退化形态 5（终核三轮实证）：本轮空转行紧邻历史引用——字符窗口判据会把
      // 紧邻的历史标记误算到本轮行上；整行结构判不受影响
      messages: [
        msg("st-u6", 1, FIXTURE_INPUT, "user"),
        msg("st-o6", 2, BAD_ADJACENT_HISTORY),
      ],
      expectedOk: false,
    },
    {
      // 退化形态 6（终核四轮实证）：历史引文闭合后夹带当前轮复判，整行不得再豁免
      messages: [
        msg("st-u7", 1, FIXTURE_INPUT, "user"),
        msg("st-o7", 2, BAD_HISTORY_REASSERT),
      ],
      expectedOk: false,
    },
  ],
};
