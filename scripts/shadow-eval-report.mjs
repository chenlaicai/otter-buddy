#!/usr/bin/env node
/**
 * F20261010gshw：影子观察统计——从 healing_events 拉取 guard_eval_shadow 对照记录，
 * 出观察期聚合报告（大獭每日呈报用）。
 *
 * 用法：node scripts/shadow-eval-report.mjs [--db <dbPath>] [--days N]
 *
 * 聚合维度（判据预注册见 F20261010gshw 特性文档「观察期判据」节）：
 * - 真误拦候选（oldVerdict=BLOCK + evaluatorWouldAllow）：逐条列出待人工裁决；
 *   已裁决数（resolution 非空）+ 真误放数（人工裁 BLOCK 保持拦截 = 求值器判错）
 * - EVAL_GAIN（oldVerdict=ALLOW + evaluatorWouldBlock）：按 ruleId/落点聚合
 * - 判据线：真误放（人工裁 BLOCK）> 0 → 建议停止切换
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

const missBlock = parsed.filter(r => r.ctx.oldVerdict === "BLOCK" && r.ctx.evaluatorWouldAllow === true);
const evalGain = parsed.filter(r => r.ctx.oldVerdict === "ALLOW" && r.ctx.evaluatorWouldBlock === true);

// 人工裁决状态：resolution 含「真误放」= 求值器判错（判据红线）；含「确认误拦」= 求值器对
const missAdjudicated = missBlock.filter(r => r.resolution && r.resolution.trim() !== "");
const trueMissPlaced = missAdjudicated.filter(r => /真误放/.test(r.resolution));
const confirmedMiss = missAdjudicated.filter(r => /确认误拦/.test(r.resolution));

console.log(`[shadow-eval-report] 近 ${days} 天观察记录 ${parsed.length} 条（db=${dbPath}）`);
console.log(`  真误拦候选：${missBlock.length} 条（已裁决 ${missAdjudicated.length}：确认误拦 ${confirmedMiss.length} / 真误放 ${trueMissPlaced.length} / 未裁决 ${missBlock.length - missAdjudicated.length}）`);
console.log(`  EVAL_GAIN：${evalGain.length} 条`);
console.log(`  判据线：真误放（人工裁 BLOCK）= ${trueMissPlaced.length} ${trueMissPlaced.length > 0 ? "⚠️ >0 —— 建议停止切换回炉（F20261010gshw 判据）" : "✅（判据 0）"}`);

// EVAL_GAIN 按旧 ruleId 聚合（none = 旧链无规则可拦）
const gainByRule = {};
for (const r of evalGain) {
  const key = r.ctx.oldRuleId ?? "none";
  gainByRule[key] = (gainByRule[key] ?? 0) + 1;
}
if (Object.keys(gainByRule).length > 0) {
  console.log("  EVAL_GAIN 按旧链 ruleId 聚合：");
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
  求值器判错（该拦没拦）→ resolution 写「真误放：<理由>」——触发判据红线`);
