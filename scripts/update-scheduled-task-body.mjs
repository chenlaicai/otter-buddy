#!/usr/bin/env node
/**
 * 更新定时任务 body 的通用脚本（F20260824dhck）
 *
 * 用法：
 *   node scripts/update-scheduled-task-body.mjs --name "每日对话健康检查" [--db <path>] [--dry-run]
 *
 * 说明：
 * - 按任务名查找 active 状态的定时任务，用 prompts/scheduled/ 下同名模板更新其 body
 * - 模板文件查找规则：prompts/scheduled/<任务名去空格转kebab>.md（如 每日对话健康检查 → daily-health-check.md）
 *   若未找到按名称匹配的模板，则扫描目录中所有 .md，取 frontmatter 的 task_name 字段匹配
 * - --dry-run：只打印 diff，不写库
 *
 * 背景：定时任务 body 曾是纯 DB 状态（issue #352 教训之一——prompt 层修复散落在 DB 里，
 * 无法走 PR 评审、无法被 git 追踪）。此脚本把 body 的真相源移到 git 仓库，
 * DB 只是运行时副本。CI 环境下跳过执行（无 DB）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** better-sqlite3 的 module.exports 即构造函数本身（CommonJS） */
const Database = require('better-sqlite3');

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { dryRun: false, name: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') parsed.dryRun = true;
    else if (args[i] === '--name') parsed.name = args[++i];
    else if (args[i] === '--db') parsed.dbPath = args[++i];
  }
  if (!parsed.name) {
    console.error('用法: node scripts/update-scheduled-task-body.mjs --name <任务名> [--dry-run]');
    process.exit(1);
  }
  return parsed;
}

function kebab(name) {
  return name.replace(/\s+/g, '-').toLowerCase();
}

function loadTemplate(taskName) {
  const dir = join(repoRoot, 'prompts', 'scheduled');
  const direct = join(dir, `${kebab(taskName)}.md`);
  if (existsSync(direct)) return { body: readFileSync(direct, 'utf8'), path: direct };
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const full = join(dir, f);
    const content = readFileSync(full, 'utf8');
    const m = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (m && new RegExp(`task_name:\\s*['"]?${taskName}['"]?`).test(m[1])) {
      // body 为 frontmatter 之后的内容
      return { body: content.slice(m[0].length), path: full };
    }
  }
  return null;
}

function main() {
  const { name, dryRun, dbPath: explicitDb } = parseArgs();
  const dbPath = explicitDb || join(repoRoot, 'data', 'otter-buddy.db');

  if (!existsSync(dbPath)) {
    console.log(`[update-task] DB 不存在（${dbPath}），跳过——CI 环境无 DB`);
    return;
  }

  // 模板永远从脚本所在仓（worktree）读，确保与 PR 内容一致

  const tpl = loadTemplate(name);
  if (!tpl) {
    console.error(`[update-task] 未找到任务「${name}」的模板（prompts/scheduled/ 下无匹配文件）`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: dryRun });
  const task = db
    .prepare(`SELECT id, name, body FROM scheduled_tasks WHERE name = ? AND status = 'active'`)
    .get(name);
  db.close();

  if (!task) {
    console.error(`[update-task] 未找到 active 任务「${name}」`);
    process.exit(1);
  }

  if (task.body.trim() === tpl.body.trim()) {
    console.log(`[update-task] 任务「${name}」body 已是最新，无需更新`);
    return;
  }

  if (dryRun) {
    console.log(`[update-task][dry-run] 任务「${name}」(${task.id}) body 将更新为 ${tpl.path} 的内容`);
    return;
  }

  const db2 = new Database(dbPath);
  db2.prepare(`UPDATE scheduled_tasks SET body = ?, updated_at = datetime('now') WHERE id = ?`).run(
    tpl.body,
    task.id
  );
  db2.close();
  console.log(`[update-task] 任务「${name}」(${task.id}) body 已更新 ← ${tpl.path}`);
}

main();
