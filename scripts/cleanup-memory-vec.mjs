#!/usr/bin/env node
/**
 * memory_vec 孤儿索引清理：默认只读 dry-run；--apply 先在线备份再单事务删除。
 * 用法：npm run build && node scripts/cleanup-memory-vec.mjs --db=/path/to.db [--apply] [--backup=/path/backup.db]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = { db: path.join(rootDir, "data", "otter-buddy.db"), apply: false, backup: null };
for (const arg of process.argv.slice(2)) {
  if (arg === "--apply") args.apply = true;
  else if (arg.startsWith("--db=")) args.db = path.resolve(arg.slice(5));
  else if (arg.startsWith("--backup=")) args.backup = path.resolve(arg.slice(9));
  else throw new Error(`未知参数: ${arg}`);
}
if (!fs.existsSync(args.db)) throw new Error(`DB 不存在: ${args.db}`);
if (args.backup && !args.apply) throw new Error("--backup 仅可与 --apply 同用");

const [{ default: Database }, { load: loadSqliteVec }, hygiene] = await Promise.all([
  import("better-sqlite3"),
  import("sqlite-vec"),
  import("../dist/src/frameworks/db/memory/memory-vec-hygiene.js"),
]);
const db = new Database(args.db, args.apply ? { fileMustExist: true } : { readonly: true, fileMustExist: true });
try {
  loadSqliteVec(db);
  if (!args.apply) {
    console.log(JSON.stringify({ mode: "dry-run", db: args.db, ...hygiene.auditMemoryVec(db) }, null, 2));
  } else {
    db.pragma("busy_timeout = 15000");
    const backupPath = args.backup ?? `${args.db}.bak-vec-hygiene-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    if (path.resolve(backupPath) === path.resolve(args.db)) throw new Error("backup 路径不得与源 DB 相同");
    if (fs.existsSync(backupPath)) throw new Error(`备份文件已存在，拒绝覆盖: ${backupPath}`);
    // Why: 在线备份包含 WAL 中已提交数据，直接复制活库主文件会丢失这部分恢复依据。
    await db.backup(backupPath);
    const result = hygiene.cleanupMemoryVec(db);
    console.log(JSON.stringify({ mode: "apply", db: args.db, backupPath, ...result }, null, 2));
  }
} finally {
  db.close();
}
