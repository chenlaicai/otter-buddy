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
 * - frontmatter 含 dynamic: true 的模板（运行时填充占位符，如 self-healing-analysis）会被跳过，
 *   不写入 DB——它们的 body 由调度器动态生成，静态同步会破坏占位符形态（issue #416）
 * - --dry-run：只打印 diff，不写库
 *
 * 背景：定时任务 body 曾是纯 DB 状态（issue #352 教训之一——prompt 层修复散落在 DB 里，
 * 无法走 PR 评审、无法被 git 追踪）。此脚本把 body 的真相源移到 git 仓库，
 * DB 只是运行时副本。CI 环境下跳过执行（无 DB）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** better-sqlite3 的 module.exports 即构造函数本身（CommonJS） */
const Database = require('better-sqlite3');

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { dryRun: false, name: null, tplDir: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') parsed.dryRun = true;
    else if (args[i] === '--name') parsed.name = args[++i];
    else if (args[i] === '--db') parsed.dbPath = args[++i];
    else if (args[i] === '--tpl-dir') parsed.tplDir = args[++i]; // 测试注入用（#430），生产默认仓内 prompts/scheduled
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

/** 从模板名找对应文件：direct path（kebab 名）优先，退回 frontmatter task_name 扫描。
 *  dir 可注入（测试用），默认仓库 prompts/scheduled/。#430 */
export function loadTemplate(taskName, dir = join(repoRoot, 'prompts', 'scheduled')) {
  const direct = join(dir, `${kebab(taskName)}.md`);
  if (existsSync(direct)) {
    const content = readFileSync(direct, 'utf8');
    if (isDynamicTemplate(content)) {
      console.log(`[update-task] 「${taskName}」是 dynamic 模板（运行时填充占位符），跳过——DB body 保持占位符形态，不能被静态文案覆盖`);
      process.exit(0);
    }
    // 与下方扫描分支一致：去掉 frontmatter，body 为 frontmatter 之后的内容
    const m = content.match(/^---\n([\s\S]*?)\n---\n/);
    return { body: m ? content.slice(m[0].length) : content, path: direct };
  }
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const full = join(dir, f);
    const content = readFileSync(full, 'utf8');
    const m = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (m && new RegExp(`task_name:\\s*['"]?${taskName}['"]?`).test(m[1])) {
      if (isDynamicTemplate(content)) {
        console.log(`[update-task] 「${taskName}」是 dynamic 模板（运行时填充占位符），跳过——DB body 保持占位符形态，不能被静态文案覆盖`);
        process.exit(0);
      }
      // body 为 frontmatter 之后的内容
      return { body: content.slice(m[0].length), path: full };
    }
  }
  return null;
}

/** dynamic 模板含运行时占位符（如 {{HEALING_DATA}}），DB 里的 body 由调度器动态生成，
 *  静态同步会破坏占位符形态（issue #416）。接受已读文件内容，避免重复 IO。
 *  值形态兼容：裸 true（含 YAML 规范的 True/TRUE 大写变体，检视#797 发现 2）/ 带引号 "true" / 行尾注释
 *  （#430 测试锁定，保守侧：宁可误判 dynamic 跳过，不覆盖 DB）。 */
export function isDynamicTemplate(fileContent) {
  const m = fileContent.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? /^dynamic:\s*['"]?(?:true|True|TRUE)['"]?\s*(?:#.*)?$/m.test(m[1]) : false;
}

function main() {
  const { name, dryRun, dbPath: explicitDb, tplDir: explicitTplDir } = parseArgs();
  const dbPath = explicitDb || join(repoRoot, 'data', 'otter-buddy.db');

  if (!existsSync(dbPath)) {
    console.log(`[update-task] DB 不存在（${dbPath}），跳过——CI 环境无 DB`);
    return;
  }

  // 模板永远从脚本所在仓（worktree）读，确保与 PR 内容一致；--tpl-dir 供测试注入（#430）

  const tpl = loadTemplate(name, explicitTplDir ?? join(repoRoot, 'prompts', 'scheduled'));
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

// 直接执行（非 import）时才跑 main——支持测试 import 函数级用例（#430）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
