#!/usr/bin/env node
/**
 * F20261026emct: embedding 幽灵死信一次性清理脚本。
 *
 * 清理对象（两类，均属「claim 永远空转的孤儿任务」）：
 *  1. last_error LIKE '%entry deleted%' 的 pending/dead 任务（2026-10-23 实测 ~1646 条）
 *  2. entry 已被删除（entry_id NOT IN memory_entries）的任务——delta 复审口径修正：
 *     检视獭 DB 实测两类差额 129 条，含 98 条 'batch timeout (49 texts)'（正是
 *     10-23 巨批雪崩残骸）——这类孤儿 claim 时同样 JOIN 不到 content，只会被
 *     打上 entry-deleted 后 3 次 dead 永久滞留（脚本一次性不再跑，出清不完整）。
 *     幽灵的真定义是「entry 不存在」，last_error 只是代理口径，本脚本改按真定义出清。
 *
 * 成因（第 1 类）：fire-and-forget embed 失败回返时 entry 已被下一轮
 * replaceEntriesBySource 删除，enqueueRetry 仍给已删 entry 插任务行。修复后
 * enqueueRetry 前置校验已断绝新幽灵产生源（embedding-task-queue.ts），本脚本只出清存量。
 *
 * 安全设计（对齐 cleanup-memory-pollution.mjs 模式）：
 *  - 默认 dry-run：只统计报告，不写 DB（readonly 打开）
 *  - --apply 才执行删除；删除前自动备份 DB 文件
 *  - --online（配合 --apply）：不停机在线清理（2026-10-26 搭档授权模式）。
 *    备份改走 better-sqlite3 db.backup()（SQLite 在线备份 API，含 WAL 已提交数据——
 *    copyFileSync 只复制主 DB，在线运行时会丢 WAL 内容）；busy_timeout 15s 等待
 *    主服务写锁释放。并发安全依据（src/frameworks/db/memory/embedding-task-queue.ts）：
 *    ① markTaskDone=DELETE / markTaskAttemptFailed=UPDATE——被删任务的运行中回写
 *       命中 0 行，不复活；② enqueueRetry 前置校验 entry 不存在即 no-op，与删除
 *       条件互斥，不会边删边插；③ claim 后行被删则 content=''，entry-deleted 分支
 *       UPDATE 0 行，安全；④ NOT EXISTS 删除条件保证 entry 存活的有效任务不受影响。
 *    隐含前提（delta 审视建议 3，未来重构不得静默破坏）：
 *    ⑤ check→insert 之间无事件循环让步：enqueueRetry 的 SELECT→INSERT 是
 *       better-sqlite3 同步调用（queue:23-35 无 await），与本脚本同进程外
 *       互斥由 SQLite 写锁保证；若改为异步 await 间隙，须重审②。
 *    ⑥ 单写进程：主服务 + 本脚本两个连接经 SQLite 写锁互斥；多主服务实例
 *       同库写不在本论证范围。
 *    ⑦ replaceEntriesBySource 删 entry→重建在单事务内（repository runInTx），
 *       其他连接快照隔离，不会看到「entry 暂不存在」的中间态；若拆出事务须重审④。
 *    缺省（无 --online）保持停机模式语义：copyFileSync 备份足够且更简单。
 *  - 只删 embedding_tasks 行——不动 memory_entries / vec / fts 任何数据
 *  - 入库中任务（pending 且 last_error IS NULL）不在清理范围：正常在途任务
 *    的 entry 必然存在（enqueueRetry 前置校验已断源），entry 不存在的 pending
 *    必是历史孤儿
 *
 * 用法：
 *   node scripts/cleanup-embedding-ghosts.mjs                    # dry-run 报告
 *   node scripts/cleanup-embedding-ghosts.mjs --apply            # 停机清理（cp 备份）
 *   node scripts/cleanup-embedding-ghosts.mjs --apply --online   # 在线清理（SQLite 在线备份）
 *   node scripts/cleanup-embedding-ghosts.mjs --db=/path/to.db   # 指定 DB（默认 data/otter-buddy.db）
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");

function parseArgs(argv) {
  const args = { apply: false, online: false, db: path.join(rootDir, "data", "otter-buddy.db") };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--online") args.online = true;
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
// 在线/停机 apply 统一设置：与主服务写连接短暂互斥时等待而非立刻 SQLITE_BUSY
if (args.apply) db.pragma("busy_timeout = 15000");

// ---------- 扫描 ----------

// 真定义口径：entry 不存在的任务（claim 永远 JOIN 不到 content，无论 last_error 形态）
const orphanCount = db.prepare(`
  SELECT COUNT(*) AS n FROM embedding_tasks et
  WHERE et.entry_id NOT IN (SELECT id FROM memory_entries)
`).get().n;

// 代理口径（子集，报告用）：last_error 含 'entry deleted' 的 pending/dead
const ghostCount = db.prepare(`
  SELECT COUNT(*) AS n FROM embedding_tasks
  WHERE last_error LIKE '%entry deleted%' AND status IN ('pending', 'dead')
`).get().n;

const statusBreakdown = db.prepare(`
    SELECT et.status, COUNT(*) AS n FROM embedding_tasks et
    WHERE et.entry_id NOT IN (SELECT id FROM memory_entries)
    GROUP BY et.status ORDER BY n DESC
  `).all();
const errorForms = db.prepare(`
    SELECT et.last_error, COUNT(*) AS n FROM embedding_tasks et
    WHERE et.entry_id NOT IN (SELECT id FROM memory_entries)
    GROUP BY et.last_error ORDER BY n DESC LIMIT 10
  `).all();

console.log(`DB: ${args.db}`);
console.log(`[orphan] entry 已删除的任务（真定义口径，将清理）: ${orphanCount} 条`);
for (const row of statusBreakdown) {
  console.log(`  - status=${row.status}: ${row.n}`);
}
for (const row of errorForms) {
  console.log(`  - last_error=${JSON.stringify(row.last_error)}: ${row.n}`);
}
console.log(`[ghost-subset] 其中 last_error='entry deleted' 且 pending/dead（代理口径子集）: ${ghostCount} 条`);

if (!args.apply) {
  console.log("\ndry-run 模式（默认）：只报告不删除。加 --apply 执行清理（停机）；--apply --online 在线清理。");
  db.close();
  process.exit(0);
}

// ---------- 执行清理 ----------

// 备份（对齐 cleanup-memory-pollution.mjs：删除前自动备份，防误删）
// --online：SQLite 在线备份 API，含 WAL 已提交数据（cp 主 DB 在线会丢 WAL）；
// 缺省停机模式：copyFileSync 足够（无 WAL 在飞写入）。
const backupPath = `${args.db}.bak-embed-ghost${args.online ? "-online" : ""}-${Date.now()}`;
if (args.online) {
  await db.backup(backupPath);
} else {
  fs.copyFileSync(args.db, backupPath);
}
console.log(`已备份${args.online ? "（在线，含 WAL）" : ""}: ${backupPath}`);

// delta 复审口径修正：按真定义（entry NOT EXISTS）删除，代理口径只是其子集。
// 停机模式：replaceEntriesBySource 同 id 回插是同步事务流程，不会落盘
// 「entry 暂不存在但即将回插」的中间态；在线模式的并发安全依据见文件头。
const deleted = db.prepare(`
  DELETE FROM embedding_tasks
  WHERE entry_id NOT IN (SELECT id FROM memory_entries)
`).run().changes;

console.log(`已删除孤儿任务 ${deleted} 条（entry 已删，claim 永远空转）。`);
console.log(`memory_entries / vec / fts 数据未动。`);

db.close();
