#!/usr/bin/env node
/**
 * F20261008gdcc P1 项 4：guard_intercept 样本 → replay 用例候选生成器。
 *
 * 背景（guard-mechanism-review 建议 4）：#1360 修的「修复-回归循环」靠人工从 healing
 * 台账翻现场再手写用例——本轮 S1 误拦（93 条/7 天）正是没被固化的现场。本脚本把
 * 「前日 guard_intercept 新样本」导出为 replay 候选 JSON，daily-health-check 獭据此
 * 走人工裁决（误拦→期望 ALLOW / 规则内→期望 BLOCK）→ 追加到
 * tests/frameworks/agent/guard-v2-real-replay.test.ts（既有 replay 用例文件）。
 *
 * 设计取舍（为什么生成候选而非直接生成测试）：
 * - 期望值判定需要语义理解（误拦 vs 规则内），机械生成会固化错误期望值
 *   （误拦样本若默认 BLOCK 就把误拦钉成了规范）——裁决必须人工/獭审
 * - 脚本只做机械部分：按日筛选、commandHead 反查完整命令（无则用原样）、
 *   ruleId 分类、脱敏（sanitizeQuotedText 同源正则的保守近似）、去重
 *
 * 用法：node scripts/generate-guard-replay.mjs [--db <path>] [--date YYYY-MM-DD] [--out <path>]
 * 退出码：0 正常（含 0 样本）；2 db 不存在。
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── 参数 ──
const args = process.argv.slice(2);
function argOf(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

// dbPath 发现：--db > 环境回退（与 daily-health-check 的 sqlite3 直查前置纪律同源：
// 先 curl /api/settings 确认 dbPath；脚本形态下由调用方传入或用默认布局）
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = resolve(argOf("--db", `${repoRoot}/data/otter.db`));
const outPath = resolve(argOf("--out", `${repoRoot}/data/guard-replay-candidates`));

if (!existsSync(dbPath)) {
  console.error(`[guard-replay] db 不存在：${dbPath}（先 curl -s http://localhost:3000/api/settings 确认 dbPath，用 --db 传入）`);
  process.exit(2);
}

// 日期窗口：--date 或默认昨天（UTC 日界，审视处置 PR #1368 §3.3：healing_events.created_at
// 是 UTC ISO 串，窗口用 UTC 日界；targetDate 也用 getUTC* 同源，避免本地时区「昨日」与
// UTC 窗错位—— Asia/Shanghai 下旧实现窗口偏移约 8h）
const targetDate = argOf("--date", (() => {
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
})());
const since = `${targetDate}T00:00:00.000Z`;
const until = `${targetDate}T23:59:59.999Z`;

const { default: Database } = await import("better-sqlite3");
const db = new Database(dbPath, { readonly: true });

// 审视处置（PR #1368 §3.3）：SQL 层强制 #1360 数据源口径——拦截结构化事件
// （context.ruleId 存在），排除 bounce 计数事件（无 ruleId，落 unknown/无法提取命令
// 噪声候选）；json_extract 兼旧格式真样本（无 ruleId 但 description 带命令前缀）。
// delta 处置（检视獭1360 实测）：json_extract 遇非法 JSON 抛 "malformed SQL JSON" 而非
// 返 NULL——旧查询无 json_extract、JS 层 try-catch 容错，本处置曾把容错挪成脆点（fix-injected
// 回归）。加 json_valid(context) 短路守卫：畸形行不炸不入选（可达性低但日跑生产库，宁可漏一条旧格式也不崩生成器）。
const rows = db.prepare(`
  SELECT id, otter_id, description, context, created_at
  FROM healing_events
  WHERE error_type = 'guard_intercept'
    AND created_at >= ? AND created_at <= ?
    AND (
      (json_valid(context) AND json_extract(context, '$.ruleId') IS NOT NULL)
      OR description LIKE '%（命令前缀：%'
    )
  ORDER BY created_at ASC
`).all(since, until);

// commandHead 从 description 反查：`（命令前缀：<head>）`（pi-session-factory 落账口径）
function extractCommandHead(description) {
  const m = description.match(/（命令前缀：([\s\S]*?)）\s*$/);
  return m ? m[1] : null;
}

// ruleId 分类（优先用落账 context.ruleId——#1360 数据源口径；缺失时标 unknown
// 由裁决侧用 guard-intercept-classify 指纹表补——脚本不复制全量指纹表防双源漂移）
function classify(row) {
  let ctx = {};
  try { ctx = JSON.parse(row.context) || {}; } catch { /* 旧格式容错 */ }
  return {
    ruleId: ctx.ruleId ?? "unknown",
    ruleLayer: ctx.ruleLayer ?? null,
    commandHead: ctx.commandHead ?? extractCommandHead(row.description) ?? "",
    hasWorktreePath: ctx.hasWorktreePath ?? (row.description.includes("/worktrees/")),
  };
}

// 脱敏：引号内文本段的保守打码（与 sanitizeQuotedText 同目标的脚本侧近似——
// 只保留结构，值段替换为占位；裁决侧人工复核后再入测试）
function sanitize(head) {
  return head
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"');
}

const seen = new Set();
const samples = [];
for (const row of rows) {
  const cls = classify(row);
  const head = cls.commandHead || "(无法提取命令——description 无命令前缀)";
  // 去重键：ruleId + 归一化命令头（同一形态反复撞只固化一条）
  const key = `${cls.ruleId}::${head.replace(/\s+/g, " ").trim()}`;
  if (seen.has(key)) continue;
  seen.add(key);
  samples.push({
    id: row.id,
    createdAt: row.created_at,
    otterId: row.otter_id,
    ruleId: cls.ruleId,
    ruleLayer: cls.ruleLayer,
    hasWorktreePath: cls.hasWorktreePath,
    description: row.description.slice(0, 300),
    commandHead: head,
    commandHeadSanitized: sanitize(head),
    verdict: null, // 裁决侧填："ALLOW"（误拦）| "BLOCK"（规则内）| "SKIP"（不值得固化）
    verdictReason: null,
  });
}

const payload = {
  generatedAt: new Date().toISOString(),
  targetDate,
  dbPath,
  totalIntercepts: rows.length,
  uniqueSamples: samples.length,
  samples,
};

mkdirSync(dirname(outPath), { recursive: true });
const outFile = `${outPath}-${targetDate}.json`;
writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);

console.log(`[guard-replay] ${targetDate} 拦截 ${rows.length} 条 → 去重后 ${samples.length} 条候选 → ${outFile}`);
console.log(`[guard-replay] 下一步：daily-health-check 獭逐条填 verdict（ALLOW/BLOCK/SKIP + 理由），`);
console.log(`[guard-replay] verdict 非 SKIP 的按 guard-v2-real-replay.test.ts 追加用例（期望值=裁决值）。`);
db.close();
