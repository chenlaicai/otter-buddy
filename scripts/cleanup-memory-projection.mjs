#!/usr/bin/env node
/**
 * entries→memory 统一投影清理：默认 dry-run；--apply 先 SQLite 在线备份再联动清理。
 * 用法：npm run build && node scripts/cleanup-memory-projection.mjs --db=/path/to.db [--apply] [--backup=/path/backup.db]
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

const [{ default: Database }, { load: loadSqliteVec }, maintenance] = await Promise.all([
  import("better-sqlite3"),
  import("sqlite-vec"),
  import("../dist/src/frameworks/db/memory/memory-projection-maintenance.js"),
]);
const db = new Database(args.db, args.apply ? { fileMustExist: true } : { readonly: true, fileMustExist: true });
try {
  loadSqliteVec(db);
  if (!args.apply) {
    const report = maintenance.auditMemoryProjection(db);
    console.log(JSON.stringify({ mode: "dry-run", db: args.db, ...report }, null, 2));
    console.log("DRY-RUN：未写 DB、未创建备份。确认后加 --apply；apply 会先备份再清理。");
  } else {
    db.pragma("busy_timeout = 15000");
    const backupPath = args.backup ?? `${args.db}.bak-c2-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    if (path.resolve(backupPath) === path.resolve(args.db)) throw new Error("backup 路径不得与源 DB 相同");
    await db.backup(backupPath);
    const result = maintenance.cleanupMemoryProjection(db);
    console.log(JSON.stringify({ mode: "apply", db: args.db, backupPath, ...result }, null, 2));
  }
} finally {
  db.close();
}
