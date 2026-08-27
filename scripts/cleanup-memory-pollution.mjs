#!/usr/bin/env node
/**
 * issue #509: memory 污染存量清理（一次性运维脚本）。
 *
 * 清理三类历史污染（8-26 daily-review 实证）：
 *  A. 空/纯空白 content 的条目（任何类型）
 *  B. 同文档重复 chunk：同一 (source_table, source_id, content_type, chunk_index) 多份，保留最新
 *  C. 孤儿 chunk：source 文档已 archived 且磁盘文件不存在的 chunk（改 ID 重入场景的旧 ID 残留）
 *
 * 安全设计：
 *  - 默认 dry-run：只扫描报告，不写 DB
 *  - --apply 才执行删除；删除前自动备份 DB 文件
 *  - 删除走单事务 + 联动清理（fts/vec/weights/edges），与 cascadeDeleteSatellites 语义一致
 *  - C 类孤儿 chunk 默认只报告不删除（归档文档的 chunk 可能仍有历史价值），--prune-orphans 显式开启
 *
 * 用法：
 *   node scripts/cleanup-memory-pollution.mjs                          # dry-run 报告
 *   node scripts/cleanup-memory-pollution.mjs --apply                  # 执行 A+B 类清理
 *   node scripts/cleanup-memory-pollution.mjs --apply --prune-orphans  # 含 C 类孤儿 chunk
 *   node scripts/cleanup-memory-pollution.mjs --db=/path/to.db         # 指定 DB（默认 data/otter-buddy.db）
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");

function parseArgs(argv) {
  // 路径假设：脚本固定从 <repo>/scripts/ 解析，rootDir = 仓库根，默认 DB 在 data/otter-buddy.db。
  // 这是一次性运维脚本（dry-run 默认 + --db 可覆盖），不接 AppConfig——主应用 DB 路径
  // 由 AppConfig.db.path 决定（默认同为 data/otter-buddy.db，见 src/bootstrap/config）。
  // 若项目结构调整导致默认路径失效，用 --db=/path/to.db 显式指定即可，不必改脚本。
  const args = { apply: false, pruneOrphans: false, db: path.join(rootDir, "data", "otter-buddy.db") };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--prune-orphans") args.pruneOrphans = true;
    else if (arg.startsWith("--db=")) args.db = arg.slice(5);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// 动态 import better-sqlite3（与主应用同依赖）
const { default: Database } = await import("better-sqlite3");

if (!fs.existsSync(args.db)) {
  console.error(`DB 不存在: ${args.db}`);
  process.exit(1);
}

const db = new Database(args.db, args.apply ? undefined : { readonly: true });

// ---------- 扫描 ----------

// A 类：空/纯空白 content
// 已知局限（PR #519 审视测试实证）：SQLite trim() 只去空格不去 \n/\t，纯换行条目
// length(trim(content))=1 抓不到。入库层防线（StoreMemory 用 JS trim，覆盖全部空白）
// 已阻断新增，存量纯换行条目如存在需手工 SQL（trim(content, char(10)||char(13)||char(9)||' ')）——
// 一次性脚本不为罕见边界加复杂度，在此声明。
const emptyEntries = db.prepare(`
  SELECT id, content_type, source_id, created_at
  FROM memory_entries
  WHERE length(trim(content)) = 0
`).all();

// B 类：同 chunk_index 重复（同 source 同 index 多份，保留最新 created_at）
const dupRows = db.prepare(`
  SELECT source_table, source_id, content_type,
         json_extract(metadata,'$.chunk_index') AS chunk_index,
         COUNT(*) AS c
  FROM memory_entries
  WHERE content_type IN ('feature_chunk','research_chunk')
  GROUP BY source_table, source_id, content_type, chunk_index
  HAVING c > 1
`).all();
const dupIds = [];
for (const g of dupRows) {
  const rows = db.prepare(`
    SELECT id FROM memory_entries
    WHERE source_table=? AND source_id=? AND content_type=?
      AND json_extract(metadata,'$.chunk_index')=?
    ORDER BY created_at DESC
  `).all(g.source_table, g.source_id, g.content_type, g.chunk_index);
  // 保留第一条（最新），其余删除
  for (const r of rows.slice(1)) dupIds.push(r.id);
}

// C 类：孤儿 chunk（source 文档 archived）
const orphanRows = db.prepare(`
  SELECT e.id, e.source_id, e.source_table, e.content_type,
         json_extract(e.metadata,'$.doc_title') AS doc_title
  FROM memory_entries e
  LEFT JOIN features f ON e.source_table='features' AND e.source_id=f.id
  LEFT JOIN research r ON e.source_table='research' AND e.source_id=r.id
  WHERE e.content_type IN ('feature_chunk','research_chunk')
    AND ((e.source_table='features' AND f.status='archived')
      OR (e.source_table='research' AND r.status='archived'))
`).all();

console.log("========== #509 污染扫描报告 ==========");
console.log(`DB: ${args.db}`);
console.log(`模式: ${args.apply ? "APPLY（实际删除）" : "DRY-RUN（只报告）"}`);
console.log();
console.log(`A. 空/纯空白 content 条目: ${emptyEntries.length}`);
for (const e of emptyEntries.slice(0, 10)) {
  console.log(`   - ${e.id} (${e.content_type}, ${e.source_id}, ${e.created_at})`);
}
if (emptyEntries.length > 10) console.log(`   ... 另 ${emptyEntries.length - 10} 条`);
console.log();
console.log(`B. 同 chunk 重复组: ${dupRows.length} 组，待删副本 ${dupIds.length} 条`);
for (const g of dupRows.slice(0, 10)) {
  console.log(`   - ${g.source_id} chunk_${g.chunk_index} ×${g.c}`);
}
console.log();
console.log(`C. 孤儿 chunk（源文档 archived）: ${orphanRows.length} 条${args.pruneOrphans ? "（本次清理）" : "（仅报告，--prune-orphans 才清理）"}`);
const orphanBySource = {};
for (const o of orphanRows) orphanBySource[o.source_id] = (orphanBySource[o.source_id] ?? 0) + 1;
for (const [sid, c] of Object.entries(orphanBySource).slice(0, 10)) {
  console.log(`   - ${sid}: ${c} chunks`);
}

if (!args.apply) {
  console.log();
  console.log("DRY-RUN 完成。加 --apply 执行清理。");
  db.close();
  process.exit(0);
}

// ---------- 执行清理 ----------

// 备份
const backupPath = `${args.db}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(args.db, backupPath);
console.log();
console.log(`已备份 DB → ${backupPath}`);

const idsToDelete = [
  ...emptyEntries.map(e => e.id),
  ...dupIds,
  ...(args.pruneOrphans ? orphanRows.map(o => o.id) : []),
];

// 联动清理（与 SqliteMemoryRepository.cascadeDeleteSatellites 语义一致）
const deleteTx = db.transaction((ids) => {
  const hasVec = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_vec'").get();
  let delVec = null;
  if (hasVec) {
    try {
      delVec = db.prepare("DELETE FROM memory_vec WHERE memory_entry_id = ?");
      delVec.run("__probe__"); // vec0 虚拟表需加载 sqlite-vec 扩展，裸连接直接 prepare 成功但 run 报错
    } catch {
      console.warn("memory_vec 是 vec0 虚拟表且扩展未加载，跳过 vec 清理（残留向量在主应用下次启动时随 reindex 自愈）");
      delVec = null;
    }
  }
  const delWeights = db.prepare("DELETE FROM memory_weights WHERE memory_entry_id = ?");
  const delTasks = db.prepare("DELETE FROM embedding_tasks WHERE entry_id = ?");
  const delEdge = db.prepare("DELETE FROM memory_edges WHERE from_entry_id = ? OR to_entry_id = ?");
  const delFts = db.prepare("DELETE FROM memory_fts_jieba WHERE memory_entry_id = ?");
  const delMain = db.prepare("DELETE FROM memory_entries WHERE id = ?");
  for (const id of ids) {
    delWeights.run(id);
    delTasks.run(id);
    delEdge.run(id, id);
    delFts.run(id);
    if (delVec) delVec.run(id);
    delMain.run(id);
  }
});

deleteTx(idsToDelete);

console.log(`已删除 ${idsToDelete.length} 条污染条目（含联动 fts/vec/weights/edges/tasks）。`);
console.log("建议重启服务触发 sync_docs 全量对账，验证 chunk_total 与实际一致。");
db.close();
