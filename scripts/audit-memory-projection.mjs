#!/usr/bin/env node
/** C2 entries→memory 只读审计。先 npm run build，再执行；输出绝无正文。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = { db: path.join(rootDir, "data", "otter-buddy.db") };
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--db=")) args.db = path.resolve(arg.slice(5));
  else throw new Error(`未知参数: ${arg}（仅支持 --db=/path/to.db）`);
}
if (!fs.existsSync(args.db)) throw new Error(`DB 不存在: ${args.db}`);

const [{ default: Database }, { load: loadSqliteVec }, { auditMemoryProjection }] = await Promise.all([
  import("better-sqlite3"),
  import("sqlite-vec"),
  import("../dist/src/frameworks/db/memory/memory-projection-maintenance.js"),
]);
const db = new Database(args.db, { readonly: true, fileMustExist: true });
try {
  loadSqliteVec(db);
  const report = auditMemoryProjection(db);
  console.log(JSON.stringify({ mode: "read-only", db: args.db, ...report }, null, 2));
} finally {
  db.close();
}
