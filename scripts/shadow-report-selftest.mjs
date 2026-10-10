#!/usr/bin/env node
/**
 * F20261010gshw：影子报告脚本自证——临时库合成 guard_eval_shadow 记录（含畸形
 * context 容错/窗外样本），跑 shadow-eval-report.mjs 核对聚合口径。
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
// 3 真误拦候选（1 确认误拦 / 1 真误放 / 1 未裁决）+ 2 EVAL_GAIN + 1 畸形 context + 1 窗外
add("s1", JSON.stringify({ oldVerdict: "BLOCK", evaluatorWouldAllow: true, oldRuleId: "main_write", commandHead: "cd /wt && git add src", hasWorktreePath: true }), "确认误拦：旧链误判", iso(1000));
add("s2", JSON.stringify({ oldVerdict: "BLOCK", evaluatorWouldAllow: true, oldRuleId: "main_write", commandHead: "git log > /repo/x", hasWorktreePath: false }), "真误放：该拦（写主仓）", iso(2000));
add("s3", JSON.stringify({ oldVerdict: "BLOCK", evaluatorWouldAllow: true, oldRuleId: "main_write", commandHead: "cd /wt && npm run build", hasWorktreePath: true }), null, iso(3000));
add("s4", JSON.stringify({ oldVerdict: "ALLOW", evaluatorWouldBlock: true, oldRuleId: "none", commandHead: "cd /wt && git add /repo/x", targetPaths: ["/repo/x"] }), null, iso(4000));
add("s5", JSON.stringify({ oldVerdict: "ALLOW", evaluatorWouldBlock: true, oldRuleId: "none", commandHead: "cd /wt && git add /repo/y", targetPaths: ["/repo/y"] }), null, iso(5000));
add("s6", "not-json{{", null, iso(6000)); // 畸形——应被容错跳过
add("s7", JSON.stringify({ oldVerdict: "BLOCK", evaluatorWouldAllow: true, oldRuleId: "main_write", commandHead: "old" }), null, iso(8 * 24 * 60 * 60 * 1000)); // 窗外
db.close();

const out = execSync(`node scripts/shadow-eval-report.mjs --db ${dbPath} --days 7`, { encoding: "utf8", cwd: process.cwd() });
console.log(out);
const fail = [];
if (!out.includes("观察记录 6 条")) fail.push("总数应 6（含畸形，不含窗外）");
if (!out.includes("真误拦候选：3 条（已裁决 2：确认误拦 1 / 真误放 1 / 未裁决 1）")) fail.push("真误拦聚合口径错");
if (!out.includes("EVAL_GAIN：2 条")) fail.push("EVAL_GAIN 计数错");
if (!out.includes("= 1 ⚠️")) fail.push("真误放判据红线未触发");
if (!out.includes("none: 2")) fail.push("EVAL_GAIN ruleId 聚合错");
if (!out.includes("npm run build")) fail.push("未裁决清单缺命令头");
fs.rmSync(dir, { recursive: true, force: true });
if (fail.length) { console.error("FAIL:", fail.join("; ")); process.exit(1); }
console.log("PASS: 报告脚本聚合口径全部核对通过");
