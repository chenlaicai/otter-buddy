#!/usr/bin/env node
/**
 * F20261010gshw：影子报告脚本自证——临时库合成 guard_eval_shadow 记录（含畸形
 * context 容错/窗外样本/r1 处置后 subkind 分桶与聚合记录），跑 shadow-eval-report.mjs
 * 核对聚合口径。
 *
 * 用法：node scripts/shadow-report-selftest.mjs（开发自检，CI 外）
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-report-test-"));
const dbPath = path.join(dir, "test.db");
const db = new Database(dbPath);
db.exec(`CREATE TABLE healing_events (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, conversation_id TEXT NOT NULL, otter_id TEXT NOT NULL,
  error_type TEXT NOT NULL, severity TEXT NOT NULL, description TEXT NOT NULL, suggestion TEXT NOT NULL DEFAULT '',
  context TEXT, status TEXT NOT NULL DEFAULT 'open', resolution TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT, introduced_by_pr TEXT, bound_issue INTEGER, bound_at TEXT)`);
const ins = db.prepare(`INSERT INTO healing_events (id, message_id, conversation_id, otter_id, error_type, severity, description, suggestion, context, status, resolution, created_at, resolved_at) VALUES (?, '', '', 'otter', 'guard_eval_shadow', 'low', 'x', '', ?, 'open', ?, ?, NULL)`);
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
// 入参：context, resolution, created_at
function add(id, ctx, resolution, createdAt) { ins.run(id, ctx, resolution, createdAt); }

// ── 个体（r1 处置后 subkind 分桶）──
// 真误拦候选 3（1 确认误拦 / 1 真误放 / 1 未裁决）+ same_block 2 + family_fallback 1 + eval_gain 2
add("s1", JSON.stringify({ kind: "shadow_eval", subkind: "miss_block_candidate", oldVerdict: "BLOCK", evaluatorWouldAllow: true, oldRuleId: "main_write", commandHead: "cd /wt && git add src", hasWorktreePath: true }), "确认误拦：旧链误判", iso(1000));
add("s2", JSON.stringify({ kind: "shadow_eval", subkind: "miss_block_candidate", oldVerdict: "BLOCK", evaluatorWouldAllow: true, oldRuleId: "main_write", commandHead: "git log > /repo/x", hasWorktreePath: false }), "真误放：该拦（写主仓）", iso(2000));
add("s3", JSON.stringify({ kind: "shadow_eval", subkind: "miss_block_candidate", oldVerdict: "BLOCK", evaluatorWouldAllow: true, oldRuleId: "main_write", commandHead: "cd /wt && npm run build", hasWorktreePath: true }), null, iso(3000));
add("s4", JSON.stringify({ kind: "shadow_eval", subkind: "eval_gain", oldVerdict: "ALLOW", evaluatorWouldBlock: true, oldRuleId: "none", commandHead: "cd /wt && git add /repo/x", targetPaths: ["/repo/x"] }), null, iso(4000));
add("s5", JSON.stringify({ kind: "shadow_eval", subkind: "eval_gain", oldVerdict: "ALLOW", evaluatorWouldBlock: true, oldRuleId: "none", commandHead: "cd /wt && git add /repo/y", targetPaths: ["/repo/y"] }), null, iso(5000));
add("s6", JSON.stringify({ kind: "shadow_eval", subkind: "same_block", oldVerdict: "BLOCK", evaluatorWouldBlock: true, oldRuleId: "main_write", commandHead: "git add /repo/z" }), null, iso(6000));
add("s7", JSON.stringify({ kind: "shadow_eval", subkind: "same_block", oldVerdict: "BLOCK", evaluatorWouldBlock: true, oldRuleId: "main_write", commandHead: "git commit -m x" }), null, iso(7000));
add("s8", JSON.stringify({ kind: "shadow_eval", subkind: "family_fallback", oldVerdict: "BLOCK", unevalReason: "var-suffix", oldRuleId: "main_write", commandHead: "W=/wt; cd $W/sub && touch f" }), null, iso(8000));
add("s9", "not-json{{", null, iso(9000)); // 畸形——应被容错跳过
// 旧数据兼容（无 subkind，r1 前形态——按 oldVerdict+wouldAllow 推断 miss_block_candidate）
add("s10", JSON.stringify({ kind: "shadow_eval", oldVerdict: "BLOCK", evaluatorWouldAllow: true, oldRuleId: "main_write", commandHead: "legacy form" }), null, iso(10000));
// ── 聚合记录（判据③数据源）──
add("a1", JSON.stringify({ kind: "shadow_eval_aggregate", total: 100, evaluated: 80, unevaluated: 20, mainWriteBlockEvaluated: 5, mainWriteBlockFallback: 2, individualsLogged: 7, dimensionMismatchBlocked: 10, unknownBlocked: 1 }), null, iso(11000));
add("a2", JSON.stringify({ kind: "shadow_eval_aggregate", total: 50, evaluated: 30, unevaluated: 20, mainWriteBlockEvaluated: 3, mainWriteBlockFallback: 1, individualsLogged: 4, dimensionMismatchBlocked: 5, unknownBlocked: 0 }), null, iso(12000));
// 窗外
add("s11", JSON.stringify({ kind: "shadow_eval", subkind: "miss_block_candidate", oldVerdict: "BLOCK", evaluatorWouldAllow: true, oldRuleId: "main_write", commandHead: "old" }), null, iso(8 * 24 * 60 * 60 * 1000));
db.close();

const out = execSync(`node scripts/shadow-eval-report.mjs --db ${dbPath} --days 7`, { encoding: "utf8", cwd: process.cwd() });
console.log(out);
const fail = [];
// 个体分桶：miss=4（3 新 + 1 legacy 兼容）/ same=2 / fb=1 / gain=2 = 9（畸形 s9 容错跳过）；聚合窗 2
if (!out.includes("个体 9 + 聚合窗 2")) fail.push(`个体/聚合计数错（期望 9+2）：${out.match(/个体 \d+ \+ 聚合窗 \d+/)?.[0]}`);
if (!out.includes("真误拦候选：4（已裁决 2：确认误拦 1 / 真误放 1 / 维度外剔除 0 / 未裁决 2）")) fail.push("真误拦聚合口径错");
if (!out.includes("① 红线（真误放，人工裁 BLOCK）= 1 ⚠️")) fail.push("判据①红线未触发");
if (!out.includes("② 族内成功率 = 28.6%（2/7")) fail.push("族内成功率口径错（same=2 / 2+4+1=7）");
if (!out.includes("③ 全量回落率 = 26.7%（Σ40/Σ150 聚合口径")) fail.push("回落率聚合口径错（Σuneval=40 / Σtotal=150）");
if (!out.includes("④ EVAL_GAIN = 2 条")) fail.push("EVAL_GAIN 计数错");
if (!out.includes("none: 2")) fail.push("EVAL_GAIN ruleId 聚合错");
if (!out.includes("聚合维度外拦截（sleep/kill 等别族，S1 过滤）：15")) fail.push("维度外聚合计数错（10+5）");
if (!out.includes("npm run build")) fail.push("未裁决清单缺命令头");
fs.rmSync(dir, { recursive: true, force: true });
if (fail.length) { console.error("FAIL:", fail.join("; ")); process.exit(1); }
console.log("PASS: 报告脚本聚合口径全部核对通过（r1 处置后：subkind 分桶 + 聚合判据③ + 维度外计数 + legacy 兼容）");
