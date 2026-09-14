#!/usr/bin/env node
/**
 * F20260914rmap：ctlv 批4c 迁移读游标重映射修复（一次性运维脚本）。
 *
 * 问题：F20260913ctlv 批4c（messages→entries）迁移对每个对话的 entries
 * 重新编号 1..N（为 yield 合成行腾独立序号），但无重叠路径漏调
 * remapReadCursors——conversation_user_read_state.last_read_message_seq
 * 仍停留在旧 messages seq 空间，而未读统计已切到 entries 序号空间。
 * 结果：所有存量对话出现大量虚假未读（实测 151 对话 / 2052 条，其中
 * 2050 条是迁移前已读过的老条目）。
 *
 * 修复：利用「entry id 沿用旧 message id」的不变量，从迁移前备份库
 * 找到旧游标所指消息 id，再查主库 entries 取其新序号，完成游标重映射：
 *   newCursor = MAX(当前游标, 旧游标所指 entry 的新 seq)
 * MAX 保证不回退迁移后用户新推进的已读进度。
 *
 * 前置：需要迁移前备份库（默认 data/backups/otter-buddy-pre-migration-20260913.db，
 * 可用 --backup= 覆盖），且其 messages / conversation_user_read_state 表完好。
 *
 * 安全设计：
 *  - 默认 dry-run：只扫描报告，不写 DB
 *  - --apply 才执行；执行前自动备份主 DB（better-sqlite3 backup API，WAL 一致）
 *  - 全部写操作走单事务，失败整体回滚
 *  - 找不到映射目标的游标行：告警跳过，不瞎猜
 *
 * 用法：
 *   node scripts/fix-read-cursor-remap.mjs                        # dry-run 报告
 *   node scripts/fix-read-cursor-remap.mjs --apply                # 执行修复
 *   node scripts/fix-read-cursor-remap.mjs --backup=/path/to.db   # 指定备份库
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");

function parseArgs(argv) {
  const args = {
    apply: false,
    db: path.join(rootDir, "data", "otter-buddy.db"),
    backup: path.join(rootDir, "data", "backups", "otter-buddy-pre-migration-20260913.db"),
  };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg.startsWith("--db=")) args.db = arg.slice(5);
    else if (arg.startsWith("--backup=")) args.backup = arg.slice(9);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const { default: Database } = await import("better-sqlite3");

if (!fs.existsSync(args.db)) {
  console.error(`主 DB 不存在: ${args.db}`);
  process.exit(1);
}
if (!fs.existsSync(args.backup)) {
  console.error(`迁移前备份库不存在: ${args.backup}\n（--backup= 可指定路径）`);
  process.exit(1);
}

const db = new Database(args.db, args.apply ? undefined : { readonly: true });
const backup = new Database(args.backup, { readonly: true });
if (args.apply) db.pragma("busy_timeout = 5000");

// ---------- 前置检查 ----------

const backupHasMessages = backup.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'",
).get();
if (!backupHasMessages) {
  console.error("备份库无 messages 表——不是迁移前备份，拒绝执行（防呆）");
  process.exit(1);
}

const migDone = db.prepare(
  "SELECT value FROM settings WHERE key = 'messages_to_entries_migrated'",
).get();
if (migDone?.value !== "done") {
  console.error("主库 messages→entries 迁移未完成（settings 标记非 done）——先跑迁移再修游标");
  process.exit(1);
}

// ---------- 扫描：逐游标行计算映射 ----------

const cursorRows = backup.prepare(
  "SELECT conversation_id, user_id, last_read_message_seq FROM conversation_user_read_state",
).all();

const getOldMsgId = backup.prepare(
  "SELECT id FROM messages WHERE conversation_id = ? AND sequence_num <= ? ORDER BY sequence_num DESC LIMIT 1",
);
const getNewSeq = db.prepare("SELECT sequence_num FROM entries WHERE id = ?");

const updates = [];   // { conversation_id, user_id, from, to }
const skipped = [];   // { conversation_id, user_id, reason }

for (const row of cursorRows) {
  const { conversation_id: convId, user_id: userId, last_read_message_seq: oldCursor } = row;
  if (oldCursor <= 0) {
    skipped.push({ convId, userId, reason: `旧游标 ${oldCursor} ≤ 0，无需映射` });
    continue;
  }
  const oldMsg = getOldMsgId.get(convId, oldCursor);
  if (!oldMsg) {
    skipped.push({ convId, userId, reason: `备份库 seq≤${oldCursor} 无消息行（异常）` });
    continue;
  }
  const newEntry = getNewSeq.get(oldMsg.id);
  if (!newEntry) {
    skipped.push({ convId, userId, reason: `entry ${oldMsg.id} 主库缺失（异常）` });
    continue;
  }
  const newCursor = Math.max(oldCursor, newEntry.sequence_num); // 不回退迁移后进度
  if (newCursor !== oldCursor) {
    updates.push({ conversation_id: convId, user_id: userId, from: oldCursor, to: newCursor });
  } else {
    skipped.push({ convId, userId, reason: `映射后不变（${oldCursor}）` });
  }
}

// ---------- 报告 ----------

console.log(`扫描 ${cursorRows.length} 条游标行：需更新 ${updates.length}，跳过 ${skipped.length}`);
for (const u of updates.slice(0, 20)) {
  console.log(`  ${u.conversation_id.slice(0, 8)} / ${u.user_id}: ${u.from} → ${u.to}`);
}
if (updates.length > 20) console.log(`  ...（其余 ${updates.length - 20} 条略）`);
for (const s of skipped.slice(0, 10)) {
  console.log(`  [跳过] ${s.convId.slice(0, 8)} / ${s.user_id}: ${s.reason}`);
}

// 修复后未读预估（dry-run 也可精确计算）
let unreadBefore = 0, unreadAfter = 0;
const unreadStmt = db.prepare(`
  SELECT COUNT(*) AS c FROM entries e
  WHERE e.conversation_id = ? AND e.sequence_num > ?
    AND e.entry_type IN ('speak', 'system')
`);
const convIds = db.prepare("SELECT id FROM conversations WHERE status != 'archived'").all();
const cursorMap = new Map(updates.map(u => [`${u.conversation_id}|${u.user_id}`, u.to]));
for (const { id } of convIds) {
  const cur = db.prepare(
    "SELECT user_id, last_read_message_seq FROM conversation_user_read_state WHERE conversation_id = ?",
  ).all(id);
  for (const r of cur) {
    const mapped = cursorMap.get(`${id}|${r.user_id}`) ?? r.last_read_message_seq;
    unreadBefore += unreadStmt.get(id, r.last_read_message_seq).c;
    unreadAfter += unreadStmt.get(id, mapped).c;
  }
}
console.log(`未读预估（speak/system，非 archived）：修复前 ${unreadBefore} → 修复后 ${unreadAfter}`);

// ---------- 执行 ----------

if (!args.apply) {
  console.log("dry-run 结束（--apply 执行修复）");
  process.exit(0);
}

if (updates.length === 0) {
  console.log("无需更新，退出");
  process.exit(0);
}

// 自动备份主 DB（backup API 保证 WAL 一致性）
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backupPath = args.db.replace(/\.db$/, "") + `-pre-read-cursor-fix-${ts}.db`;
await db.backup(backupPath);
console.log(`已备份主 DB → ${backupPath}`);

const applyOne = db.prepare(
  "UPDATE conversation_user_read_state SET last_read_message_seq = ?, updated_at = datetime('now') WHERE conversation_id = ? AND user_id = ?",
);
const tx = db.transaction(() => {
  for (const u of updates) applyOne.run(u.to, u.conversation_id, u.user_id);
});
tx();
console.log(`✅ 已更新 ${updates.length} 条游标`);
