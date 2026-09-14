#!/usr/bin/env node
/**
 * F20260914rmap：ctlv 批4c 迁移读游标重映射修复（一次性运维脚本）。
 *
 * 问题：F20260913ctlv 批4c（messages→entries）迁移对每个对话的 entries
 * 重新编号 1..N（为 yield 合成行腾独立序号），但无重叠路径漏调
 * remapReadCursors——两张读游标表滞留旧 messages seq 空间：
 *   A. conversation_user_read_state.last_read_message_seq（Web 用户游标）
 *   B. conversation_participants.last_read_seq（otter 獭游标，getUnreadEntries 注入依据）
 * 而未读统计已切到 entries 序号空间 → 存量游标之后的已读老条目全部被误判未读
 * （生产实测：用户侧 151 对话 2052 条虚假未读）。
 *
 * 修复：利用「entry id 沿用旧 message id」的不变量，从迁移前备份库找到旧游标
 * 所指消息 id，再查主库 entries 取其新序号：
 *   target = MAX(主库当前游标, 旧游标所指 entry 的新序号)
 * MAX 以主库当前值为基准（不是备份库值）——迁移后用户/獭可能已在新序号空间
 * 推进过游标，绝不能写回。
 *
 * 前置：需要迁移前备份库（默认 data/backups/otter-buddy-pre-migration-20260913.db，
 * 可用 --backup= 覆盖），且其 messages 表完好（防呆：无 messages 表即拒绝）。
 *
 * 安全设计：
 *  - 默认 dry-run：只扫描报告，不写 DB
 *  - --apply 才执行；执行前自动备份主 DB（better-sqlite3 backup API，WAL 一致）
 *  - 全部写操作走单事务，失败整体回滚
 *  - 幂等：target 以主库当前值为基准，重跑零更新
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
const backupPartRows = backup.prepare(
  "SELECT conversation_id, otter_id, last_read_seq FROM conversation_participants WHERE last_read_seq IS NOT NULL",
).all();

const getOldMsgId = backup.prepare(
  "SELECT id FROM messages WHERE conversation_id = ? AND sequence_num <= ? ORDER BY sequence_num DESC LIMIT 1",
);
const getNewSeq = db.prepare("SELECT sequence_num FROM entries WHERE id = ?");
const getCurUrs = db.prepare(
  "SELECT last_read_message_seq FROM conversation_user_read_state WHERE conversation_id = ? AND user_id = ?",
);
const getCurPart = db.prepare(
  "SELECT last_read_seq FROM conversation_participants WHERE conversation_id = ? AND otter_id = ?",
);

const updates = [];      // 用户游标 { conversation_id, user_id, from, to }（from/to 均为主库当前空间）
const partUpdates = [];  // 獭游标 { conversation_id, otter_id, from, to }
const skipped = [];      // { table, convId, who, reason }

/** 旧游标（备份库空间）→ 旧前缀末条消息 id 所指 entry 的新序号；null = 异常跳过 */
function mapOldCursor(convId, oldCursor) {
  const oldMsg = getOldMsgId.get(convId, oldCursor);
  if (!oldMsg) return { reason: `备份库 seq≤${oldCursor} 无消息行（异常）` };
  const newEntry = getNewSeq.get(oldMsg.id);
  if (!newEntry) return { reason: `entry ${oldMsg.id} 主库缺失（异常）` };
  return { newSeq: newEntry.sequence_num };
}

// A. 用户游标
for (const row of cursorRows) {
  const { conversation_id: convId, user_id: userId, last_read_message_seq: oldCursor } = row;
  if (userId == null) { skipped.push({ table: "urs", convId, who: "NULL", reason: "user_id 为空，无法定位行" }); continue; }
  if (oldCursor <= 0) continue; // 0 语义两空间等价
  const m = mapOldCursor(convId, oldCursor);
  if (m.reason) { skipped.push({ table: "urs", convId, who: userId, reason: m.reason }); continue; }
  const cur = getCurUrs.get(convId, userId)?.last_read_message_seq ?? 0;
  const target = Math.max(cur, m.newSeq); // MAX 对主库当前值——迁移后新推进绝不回退
  if (target !== cur) updates.push({ conversation_id: convId, user_id: userId, from: cur, to: target });
}

// B. 獭游标（getUnreadEntries 注入依据，漏修则獭重复消费旧消息）
for (const row of backupPartRows) {
  const { conversation_id: convId, otter_id: otterId, last_read_seq: oldCursor } = row;
  if (otterId == null) { skipped.push({ table: "part", convId, who: "NULL", reason: "otter_id 为空，无法定位行" }); continue; }
  if (oldCursor <= 0) continue;
  const m = mapOldCursor(convId, oldCursor);
  if (m.reason) { skipped.push({ table: "part", convId, who: otterId, reason: m.reason }); continue; }
  const cur = getCurPart.get(convId, otterId)?.last_read_seq ?? 0;
  const target = Math.max(cur, m.newSeq);
  if (target !== cur) partUpdates.push({ conversation_id: convId, otter_id: otterId, from: cur, to: target });
}

// ---------- 报告 ----------

console.log(`扫描：用户游标 ${cursorRows.length} 条（需更新 ${updates.length}），獭游标 ${backupPartRows.length} 条（需更新 ${partUpdates.length}），跳过 ${skipped.length}`);
for (const u of updates.slice(0, 10)) {
  console.log(`  [user] ${u.conversation_id.slice(0, 8)} / ${u.user_id}: ${u.from} → ${u.to}`);
}
if (updates.length > 10) console.log(`  ...（其余 user ${updates.length - 10} 条略）`);
for (const u of partUpdates.slice(0, 10)) {
  console.log(`  [otter] ${u.conversation_id.slice(0, 8)} / ${u.otter_id.slice(0, 8)}: ${u.from} → ${u.to}`);
}
if (partUpdates.length > 10) console.log(`  ...（其余 otter ${partUpdates.length - 10} 条略）`);
for (const s of skipped.slice(0, 10)) {
  console.log(`  [跳过:${s.table}] ${s.convId.slice(0, 8)} / ${s.who}: ${s.reason}`);
}

// 未读预估（主库当前值 vs 修复后；对齐各消费方真实语义）
let unreadBefore = 0, unreadAfter = 0;
const userUnreadStmt = db.prepare(`
  SELECT COUNT(*) AS c FROM entries e
  WHERE e.conversation_id = ? AND e.sequence_num > ?
    AND e.entry_type IN ('speak', 'system')
`);
const userCursorMap = new Map(updates.map(u => [`${u.conversation_id}|${u.user_id}`, u.to]));
for (const r of db.prepare(`
  SELECT u.conversation_id, u.user_id, u.last_read_message_seq FROM conversation_user_read_state u
  JOIN conversations c ON c.id = u.conversation_id AND c.status != 'archived'
`).all()) {
  const mapped = userCursorMap.get(`${r.conversation_id}|${r.user_id}`) ?? r.last_read_message_seq;
  unreadBefore += userUnreadStmt.get(r.conversation_id, r.last_read_message_seq).c;
  unreadAfter += userUnreadStmt.get(r.conversation_id, mapped).c;
}
console.log(`用户未读预估（speak/system，非 archived）：修复前 ${unreadBefore} → 修复后 ${unreadAfter}`);

let otterBefore = 0, otterAfter = 0;
const otterUnreadStmt = db.prepare(`
  SELECT COUNT(*) AS c FROM entries e
  WHERE e.conversation_id = ? AND e.sequence_num > ?
    AND e.sender_id != ?
    AND e.entry_type IN ('user', 'system', 'speak') AND e.status = 'completed'
`);
const partCursorMap = new Map(partUpdates.map(u => [`${u.conversation_id}|${u.otter_id}`, u.to]));
for (const r of db.prepare(`
  SELECT p.conversation_id, p.otter_id, p.last_read_seq FROM conversation_participants p
  JOIN conversations c ON c.id = p.conversation_id AND c.status != 'archived'
  WHERE p.status = 'active' AND p.last_read_seq IS NOT NULL
`).all()) {
  const mapped = partCursorMap.get(`${r.conversation_id}|${r.otter_id}`) ?? r.last_read_seq;
  otterBefore += otterUnreadStmt.get(r.conversation_id, r.last_read_seq, r.otter_id).c;
  otterAfter += otterUnreadStmt.get(r.conversation_id, mapped, r.otter_id).c;
}
console.log(`獭未读预估（getUnreadEntries 语义）：修复前 ${otterBefore} → 修复后 ${otterAfter}`);

// ---------- 执行 ----------

if (!args.apply) {
  console.log("dry-run 结束（--apply 执行修复）");
  process.exit(0);
}

if (updates.length === 0 && partUpdates.length === 0) {
  console.log("无需更新，退出");
  process.exit(0);
}

// 自动备份主 DB（backup API 保证 WAL 一致性）
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backupPath = args.db.replace(/\.db$/, "") + `-pre-read-cursor-fix-${ts}.db`;
await db.backup(backupPath);
console.log(`已备份主 DB → ${backupPath}`);

const applyUrs = db.prepare(
  "UPDATE conversation_user_read_state SET last_read_message_seq = ?, updated_at = datetime('now') WHERE conversation_id = ? AND user_id = ?",
);
const applyPart = db.prepare(
  "UPDATE conversation_participants SET last_read_seq = ? WHERE conversation_id = ? AND otter_id = ?",
);
const tx = db.transaction(() => {
  for (const u of updates) applyUrs.run(u.to, u.conversation_id, u.user_id);
  for (const u of partUpdates) applyPart.run(u.to, u.conversation_id, u.otter_id);
});
tx();
console.log(`✅ 已更新：用户游标 ${updates.length} 条，獭游标 ${partUpdates.length} 条`);
