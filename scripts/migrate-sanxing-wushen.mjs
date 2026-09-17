#!/usr/bin/env node
/**
 * F20260917swsh：三省吾身定时任务整合——存量 DB 一次性迁移脚本。
 *
 * 背景：搭档 2026-09-17 拍板，把 5 个「每日三省吾身」类定时任务收拢到单一对话
 * 《三省吾身》（原 🩺 Self-Healing 对话改名），重排时间轴，删除每日复盘 /
 * backlog digest 两个任务，归档三个旧对话。
 *
 * 本脚本对存量 DB 执行（幂等，可重复运行）：
 *   1. 对话 3241317b…（原 🩺 Self-Healing）改名为《🦦 三省吾身》
 *   2. 重排 cron：健康检查 9:00→8:30、self-healing-analysis 10:00→9:00、
 *      每日 issue 处理 10:30→9:30 且 disabled→active
 *   3. 新建「未闭环扫描」7:30 任务（body 从 prompts/scheduled/未闭环扫描.md 读取）
 *   4. 依赖升级自动化、上下文管理机制观察挪入三省吾身对话
 *   5. 删除 daily-review、backlog digest 两个任务
 *   6. 归档三个旧对话：📖 每日复盘 / 📋 Backlog 排期 / 架构整洁和过度设计
 *      及其中的旧对话（上下文压缩交接相关的优化）
 *
 * 用法：
 *   node scripts/migrate-sanxing-wushen.mjs [--db <path>] [--dry-run]
 * 默认 db 路径自动从 http://localhost:3000/api/settings 读取（#791 纪律），
 * 服务不在线时退回 ./data/otter-buddy.db。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const SANXING_CONV_ID = '3241317b-99d6-4d78-9248-ff208a7461bc'; // 原 🩺 Self-Healing
const ARCHIVE_CONV_IDS = [
  '4ef4e922-e6ab-43e6-ab9c-75d082125b1e', // 📖 每日复盘
  'a56c349e-c566-438c-97d0-653a260171ed', // 📋 Backlog 排期
  'a344e752-8e89-469a-ad04-5a5108867fa0', // 架构整洁和过度设计
  '9d326c9d-9818-40a2-9982-898315fe7aa4', // 上下文压缩交接相关的优化（其任务挪走后归档）
];

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { dryRun: false, dbPath: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') parsed.dryRun = true;
    else if (args[i] === '--db') parsed.dbPath = args[++i];
  }
  return parsed;
}

async function resolveDbPath(explicit) {
  if (explicit) return explicit;
  try {
    const res = await fetch('http://localhost:3000/api/settings');
    const json = await res.json();
    if (json.dbPath) return json.dbPath.startsWith('/') ? json.dbPath : join(repoRoot, json.dbPath);
  } catch { /* 服务不在线，退回默认 */ }
  return join(repoRoot, 'data', 'otter-buddy.db');
}

const { dryRun } = parseArgs();
const argsParsed = parseArgs();
const dbPath = await resolveDbPath(argsParsed.dbPath);
console.log(`[migrate] db = ${dbPath}${dryRun ? '（dry-run，不写库）' : ''}`);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const changes = [];
const run = (sql, params, label) => {
  const stmt = db.prepare(sql);
  if (dryRun) {
    console.log(`[dry-run] ${label}`);
    changes.push(label);
    return { changes: 0 };
  }
  const r = stmt.run(...params);
  if (r.changes > 0) { changes.push(`${label}（${r.changes} 行）`); console.log(`[ok] ${label}（${r.changes} 行）`); }
  else console.log(`[skip] ${label}（0 行，可能已迁移）`);
  return r;
};

// 1. 对话改名
run(`UPDATE conversations SET title = '🦦 三省吾身', updated_at = datetime('now') WHERE id = ?`,
  [SANXING_CONV_ID], '对话改名：🩺 Self-Healing → 🦦 三省吾身');

// 2. 重排 cron + 复活 issue 处理
run(`UPDATE scheduled_tasks SET cron = '30 8 * * *', updated_at = datetime('now') WHERE name = '每日对话健康检查' AND cron != '30 8 * * *'`,
  [], '健康检查 9:00 → 8:30');
run(`UPDATE scheduled_tasks SET cron = '0 9 * * *', updated_at = datetime('now') WHERE name = 'self-healing-analysis' AND cron != '0 9 * * *'`,
  [], 'self-healing-analysis 10:00 → 9:00');
run(`UPDATE scheduled_tasks SET cron = '30 9 * * *', status = 'active', updated_at = datetime('now') WHERE name = '每日 issue 处理' AND (cron != '30 9 * * *' OR status != 'active')`,
  [], '每日 issue 处理 10:30 → 9:30 且复活（disabled→active）');

// 3. 新建未闭环扫描任务（幂等：同名任务存在则跳过）
const scanPromptPath = join(repoRoot, 'prompts', 'scheduled', '未闭环扫描.md');
if (!existsSync(scanPromptPath)) {
  console.error(`[error] 模板不存在：${scanPromptPath}——请确认本脚本在合入后的仓库根运行`);
  process.exit(1);
}
const scanBody = readFileSync(scanPromptPath, 'utf-8');
const existing = db.prepare(`SELECT id FROM scheduled_tasks WHERE name = '未闭环扫描'`).get();
if (existing) {
  console.log('[skip] 未闭环扫描任务已存在');
} else if (dryRun) {
  console.log('[dry-run] 新建「未闭环扫描」任务（7:30，三省吾身对话）');
  changes.push('新建未闭环扫描任务');
} else {
  // 取三省吾身对话的 big otter 作为发言石持有者（与既有任务一致）
  const refTask = db.prepare(`SELECT talking_stone_passed_to, sender_id, restart_before_invoke, timeout_minutes FROM scheduled_tasks WHERE conversation_id = ? AND name = '每日对话健康检查'`).get(SANXING_CONV_ID);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO scheduled_tasks (id, conversation_id, name, cron, timezone, body, talking_stone_passed_to, sender_id, status, consecutive_failures, created_at, updated_at, schedule_type, restart_before_invoke, timeout_minutes, description)
    VALUES (?, ?, '未闭环扫描', '30 7 * * *', 'Asia/Shanghai', ?, ?, ?, 'active', 0, ?, ?, 'cron', ?, ?, ?)`)
    .run(randomUUID(), SANXING_CONV_ID, scanBody,
      refTask?.talking_stone_passed_to ?? '[]', refTask?.sender_id ?? 'system', now, now,
      refTask?.restart_before_invoke ?? 1, refTask?.timeout_minutes ?? 30,
      '每日 7:30 翻昨日对话捞「回头再说/未收尾」事项，统一开 issue（F20260917swsh）');
  changes.push('新建未闭环扫描任务（7:30）');
  console.log('[ok] 新建未闭环扫描任务（7:30）');
}

// 4. 任务挪入三省吾身对话
for (const name of ['依赖升级自动化', '上下文管理机制观察（每周一）']) {
  run(`UPDATE scheduled_tasks SET conversation_id = ?, updated_at = datetime('now') WHERE name = ? AND conversation_id != ?`,
    [SANXING_CONV_ID, name, SANXING_CONV_ID], `任务挪入三省吾身：${name}`);
}

// 5. 删除 daily-review / backlog digest 任务
for (const name of ['daily-review', 'backlog digest']) {
  run(`DELETE FROM scheduled_tasks WHERE name = ?`, [name], `删除任务：${name}`);
}

// 6. 归档旧对话
for (const id of ARCHIVE_CONV_IDS) {
  run(`UPDATE conversations SET status = 'archived', archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'active'`,
    [id], `归档对话 ${id.slice(0, 8)}`);
}

console.log(`\n[migrate] 完成，${changes.length} 项变更：`);
changes.forEach(c => console.log(`  - ${c}`));
if (dryRun) console.log('[migrate] dry-run 未写库，去掉 --dry-run 真实执行');
db.close();
