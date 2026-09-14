#!/usr/bin/env node
/**
 * issue #753：S2 事故遗留清理（一次性运维脚本）。
 *
 * 清理两类遗留：
 *  A. dissolved 獭的 active otter_sessions 幽灵行 → 标 archived（archive_reason='ghost_cleanup'）
 *     源头：agent-invoker backfill 兜底不查 otter 状态（已由本特性代码修复堵漏），
 *     存量 12 行是 9/2 S2 事故（No session or config found 热循环）期间给 dissolved 獭建的。
 *     不物理删除——保留事故考古价值，标 archived 即脱离 active 视野。
 *  B. 会话 31767a2b（mac touch bar）的 617 条 failed 消息（42 秒热循环产物）→ 物理删除
 *     理由：status='failed' 的截断错误消息（body 均为「[错误] No session or config found」），
 *     已完成消息 76 条保留完整对话脉络；failed 行留着的唯一作用是污染 memory 检索与统计。
 *
 * 安全设计：
 *  - 默认 dry-run：只扫描报告，不写 DB
 *  - --apply 才执行；执行前自动备份 DB 文件到同目录
 *  - 全部写操作走单事务，失败整体回滚
 *
 * 用法：
 *   node scripts/cleanup-ghost-sessions-753.mjs           # dry-run 报告
 *   node scripts/cleanup-ghost-sessions-753.mjs --apply   # 执行清理
 *   node scripts/cleanup-ghost-sessions-753.mjs --db=/path/to.db
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");

function parseArgs(argv) {
  const args = { apply: false, db: path.join(rootDir, "data", "otter-buddy.db") };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg.startsWith("--db=")) args.db = arg.slice(5);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const { default: Database } = await import("better-sqlite3");

if (!fs.existsSync(args.db)) {
  console.error(`DB 不存在: ${args.db}`);
  process.exit(1);
}

const db = new Database(args.db, args.apply ? undefined : { readonly: true });

// ---------- 扫描 ----------

// A 类：dissolved 獭的 active session 幽灵行
const ghostSessions = db.prepare(`
  SELECT s.id, s.otter_id, o.name, s.started_at
  FROM otter_sessions s JOIN otters o ON o.id = s.otter_id
  WHERE o.status = 'dissolved' AND s.status = 'active'
`).all();

// B 类：31767a2b 会话的 failed 消息
const TARGET_CONV = "31767a2b-4cb0-42d7-99c8-1afec8de6f08";
const failedMsgs = db.prepare(`
  SELECT id FROM messages WHERE conversation_id = ? AND status = 'failed'
`).all(TARGET_CONV);
const completedCount = db.prepare(`
  SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND status != 'failed'
`).get(TARGET_CONV).n;

console.log("=== #753 遗留清理扫描报告 ===\n");
console.log(`A. dissolved 獭 active 幽灵 session 行: ${ghostSessions.length}`);
for (const g of ghostSessions) {
  console.log(`   ${g.id.slice(0, 8)} otter=${g.name}(${g.otter_id.slice(0, 8)}) started=${g.started_at}`);
}
console.log(`\nB. 会话 ${TARGET_CONV.slice(0, 8)} failed 消息: ${failedMsgs.length} 条（保留 completed 等 ${completedCount} 条）`);

if (!args.apply) {
  console.log("\n[dry-run] 未写库。加 --apply 执行（执行前自动备份 DB）。");
  process.exit(0);
}

// ---------- 执行 ----------

const backup = `${args.db}.bak-753-${new Date().toISOString().replace(/[:.]/g, "-")}`;
db.close();
fs.copyFileSync(args.db, backup);
console.log(`\nDB 已备份: ${backup}`);

const dbw = new Database(args.db);
const tx = dbw.transaction(() => {
  // A：幽灵行标 archived（保留考古，不物理删除）
  const archiveStmt = dbw.prepare(`
    UPDATE otter_sessions SET status = 'archived', archived_at = ?, archive_reason = 'ghost_cleanup_753'
    WHERE id = ?
  `);
  const now = new Date().toISOString();
  for (const g of ghostSessions) archiveStmt.run(now, g.id);

  // B：failed 消息物理删除（级联清理，顺序按 FK 依赖）
  // - message_segments：ON DELETE CASCADE（schema.ts:171），随 messages 删除自动清理，无需手动
  // - message_events：FK 无 CASCADE（schema.ts:157）→ 手动删除
  // - dispatch_attempts：FK 无 CASCADE（schema.ts:782）→ 手动删除（#847 检视严重发现 1：漏了它 --apply 会抛 FOREIGN KEY constraint failed）
  const msgIds = failedMsgs.map(m => m.id);
  const delEvt = dbw.prepare(`DELETE FROM message_events WHERE message_id = ?`);
  const delDisp = dbw.prepare(`DELETE FROM dispatch_attempts WHERE message_id = ?`);
  const delMsg = dbw.prepare(`DELETE FROM messages WHERE id = ? AND status = 'failed'`);
  for (const id of msgIds) {
    delEvt.run(id);
    delDisp.run(id);
    delMsg.run(id);
  }
  return { archived: ghostSessions.length, deleted: msgIds.length };
});

const result = tx();
console.log(`\n✅ 清理完成：${result.archived} 条幽灵 session 标 archived，${result.deleted} 条 failed 消息已删除`);
console.log(`回滚方式：cp "${backup}" "${args.db}"`);
dbw.close();
