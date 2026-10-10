#!/usr/bin/env node
/**
 * F20261010gshw：影子观察统计——从 healing_events 拉取 guard_eval_shadow 对照记录，
 * 出观察期聚合报告（大獭每日呈报用）。
 *
 * 用法：node scripts/shadow-eval-report.mjs [--db <dbPath>] [--days N]
 *
 * 数据源两形态（审视 r1 S2 处置后的口径）：
 * - 个体记录（kind=shadow_eval，subkind 分桶）：真误拦候选（人工裁决队列）/
 *   EVAL_GAIN / same_block / family_fallback（族内判据逐条证据，防抖后口径）
 * - 聚合记录（kind=shadow_eval_aggregate）：进程内计数器按窗落账——全量
 *   total/evaluated/unevaluated（pre-dedup 流量口径），判据③④（覆盖率/回落率）数据源
 *
 * 判据口径（预注册，F20261010gshw 特性文档「观察期判据」节 + r1 处置）：
 * - ① 红线（真误放）：miss_block_candidate 人工裁 BLOCK > 0 → 建议停止切换回炉
 *   ——仅 main_write 维度拦截进候选池（S1 维度过滤，sleep/kill 别族拦截不进）
 * - ② 族内成功率：same_block / (same_block + miss_block_candidate + family_fallback)
 *   ≥ 90%（个体记录口径）
 * - ③ 全量回落率：Σ unevaluated / Σ total（聚合记录口径）≤ 50%
 * - ④ EVAL_GAIN：按 oldRuleId 聚合（none = 旧链无规则可拦），收益量化不设线
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const args = process.argv.slice(2);
function argOf(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const dbPath = argOf("--db", "data/otter-buddy.db");
const days = Number(argOf("--days", "7"));

const db = new Database(dbPath, { readonly: true });
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const rows = db.prepare(`
  SELECT id, otter_id, description, context, status, resolution, created_at
  FROM healing_events
  WHERE error_type = 'guard_eval_shadow' AND created_at >= ?
  ORDER BY created_at DESC
`).all(since);

const parsed = rows.map(r => {
  let ctx = {};
  try { ctx = JSON.parse(r.context ?? "{}"); } catch { /* 畸形 context 跳过（json_valid 同型容错） */ }
  return { ...r, ctx };
});

const individuals = parsed.filter(r => r.ctx.kind === "shadow_eval");
const aggregates = parsed.filter(r => r.ctx.kind === "shadow_eval_aggregate");

// ── 个体分桶（S1 处置：subkind 键；旧数据无 subkind 兼容——按形态推断） ──
const bySub = (sub) => individuals.filter(r => r.ctx.subkind === sub
  || (r.ctx.subkind === undefined && (sub === "miss_block_candidate" ? (r.ctx.oldVerdict === "BLOCK" && r.ctx.evaluatorWouldAllow === true) : false)));
const missBlock = bySub("miss_block_candidate");
const evalGain = individuals.filter(r => r.ctx.subkind === "eval_gain"
  || (r.ctx.subkind === undefined && r.ctx.oldVerdict === "ALLOW" && r.ctx.evaluatorWouldBlock === true));
const sameBlock = bySub("same_block");
const familyFallback = bySub("family_fallback");

// 人工裁决状态（miss_block_candidate 队列）：resolution 含「真误放」= 求值器判错（判据红线）；
// 「确认误拦」= 求值器对；「维度外」= r1 处置前误入池的样本（剔除不计）
const missAdjudicated = missBlock.filter(r => r.resolution && r.resolution.trim() !== "");
const trueMissPlaced = missAdjudicated.filter(r => /真误放/.test(r.resolution));
const confirmedMiss = missAdjudicated.filter(r => /确认误拦/.test(r.resolution));
const dimExcluded = missAdjudicated.filter(r => /维度外/.test(r.resolution));

// ── 聚合计数（S2 处置：判据③ 全量回落率） ──
const aggTotal = aggregates.reduce((s, r) => s + (Number(r.ctx.total) || 0), 0);
const aggUneval = aggregates.reduce((s, r) => s + (Number(r.ctx.unevaluated) || 0), 0);
const aggDimMismatch = aggregates.reduce((s, r) => s + (Number(r.ctx.dimensionMismatchBlocked) || 0), 0);
const fallbackRate = aggTotal > 0 ? ((aggUneval / aggTotal) * 100).toFixed(1) : "n/a";

// ── 族内成功率（判据②，个体口径） ──
const familyDenom = sameBlock.length + missBlock.length + familyFallback.length;
const familyRate = familyDenom > 0 ? ((sameBlock.length / familyDenom) * 100).toFixed(1) : "n/a";

console.log(`[shadow-eval-report] 近 ${days} 天观察记录 ${parsed.length} 条（个体 ${individuals.length} + 聚合窗 ${aggregates.length}；db=${dbPath}）`);

console.log(`\n── 判据四项（预注册口径，r1 处置后）──`);
console.log(`  ① 红线（真误放，人工裁 BLOCK）= ${trueMissPlaced.length} ${trueMissPlaced.length > 0 ? "⚠️ >0 —— 建议停止切换回炉（F20261010gshw 判据）" : "✅（判据 0）"}`);
console.log(`  ② 族内成功率 = ${familyRate}%（${sameBlock.length}/${familyDenom}，判据 ≥90%${familyDenom > 0 && Number(familyRate) >= 90 ? " ✅" : familyDenom > 0 ? " ❌" : "（暂无数据）"}）`);
console.log(`  ③ 全量回落率 = ${fallbackRate}%（Σ${aggUneval}/Σ${aggTotal} 聚合口径，判据 ≤50%${aggTotal > 0 && Number(fallbackRate) <= 50 ? " ✅" : aggTotal > 0 ? " ❌" : "（暂无数据）"}）`);
console.log(`  ④ EVAL_GAIN = ${evalGain.length} 条（收益量化，不设线）`);

console.log(`\n── 个体分桶（防抖后口径）──`);
console.log(`  真误拦候选：${missBlock.length}（已裁决 ${missAdjudicated.length}：确认误拦 ${confirmedMiss.length} / 真误放 ${trueMissPlaced.length} / 维度外剔除 ${dimExcluded.length} / 未裁决 ${missBlock.length - missAdjudicated.length}）`);
console.log(`  same_block：${sameBlock.length} ｜ family_fallback：${familyFallback.length} ｜ eval_gain：${evalGain.length}`);
console.log(`  聚合维度外拦截（sleep/kill 等别族，S1 过滤）：${aggDimMismatch}`);

// EVAL_GAIN 按旧 ruleId 聚合（none = 旧链无规则可拦）
const gainByRule = {};
for (const r of evalGain) {
  const key = r.ctx.oldRuleId ?? "none";
  gainByRule[key] = (gainByRule[key] ?? 0) + 1;
}
if (Object.keys(gainByRule).length > 0) {
  console.log(`\n  EVAL_GAIN 按旧链 ruleId 聚合：`);
  for (const [k, v] of Object.entries(gainByRule).sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${v}`);
}

// 未裁决真误拦候选逐条（人工裁决工作清单）
const pending = missBlock.filter(r => !r.resolution || r.resolution.trim() === "");
if (pending.length > 0) {
  console.log(`\n  未裁决候选（逐条人工裁决，前 20 条）：`);
  for (const r of pending.slice(0, 20)) {
    console.log(`    [${r.created_at.slice(0, 16)}] ${String(r.ctx.commandHead ?? "").slice(0, 90)}`);
    console.log(`      id=${r.id.slice(0, 8)} ruleId=${r.ctx.oldRuleId} wt=${r.ctx.hasWorktreePath ? "Y" : "N"}`);
  }
  if (pending.length > 20) console.log(`    …共 ${pending.length} 条`);
}

// 裁决操作指引（人工如何写 resolution）
console.log(`
裁决操作（manage_healing_events 或 DB update）：
  确认求值器对（旧链误拦）→ resolution 写「确认误拦：<理由>」
  求值器判错（该拦没拦）→ resolution 写「真误放：<理由>」——触发判据①红线
  维度外样本（r1 处置前误入池）→ resolution 写「维度外：<理由>」——剔除不计`);
