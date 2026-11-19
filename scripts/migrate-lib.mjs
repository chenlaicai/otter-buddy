#!/usr/bin/env node
/* global Buffer */
/**
 * 迁移工具共享库（阶段 6b：迁移校验与回退）。
 *
 * 被 migrate-export / migrate-restore / migrate-verify 三个 CLI 与 vitest 共用。
 * 导出纯函数 + 少量 fs 操作封装，不持全局状态（可测性）。
 *
 * manifest 结构（JSON，与产物旁置 + 打包内各一份）：
 * {
 *   version: 1,
 *   createdAt: ISO,
 *   sourceRoot: 绝对路径（诊断），
 *   files: [{ path: 相对路径, size, sha256 }],
 *   databases: { "<相对路径>": { tables: { "<表名>": 行数 } } },
 *   options: { excludes: [...], gzip: bool }
 * }
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

/** 迁移数据域：data/ 下的子目录与文件白名单（核心集——不含 models/backups/logs/rehearsal 库） */
export const MIGRATE_INCLUDES = [
  "workspaces", "sessions", "durable-sessions", "attachments",
  "feishu", "metrics", "otter-buddy.db", "owner-password",
];

/** sqlite 文件识别（主库 + durable-sessions 每会话一库） */
function isSqliteFile(relPath) {
  return relPath === "otter-buddy.db" || relPath.startsWith("durable-sessions/");
}

/** 收集迁移域文件清单（相对路径，排序稳定） */
export function collectMigrateFiles(dataDir) {
  const out = [];
  for (const name of MIGRATE_INCLUDES) {
    const abs = path.join(dataDir, name);
    if (!fs.existsSync(abs)) continue; // 可选项缺失不阻断（如 feishu 未配置）
    const stat = fs.lstatSync(abs);
    if (stat.isDirectory()) {
      for (const rel of walkSorted(abs)) out.push(path.join(name, rel));
    } else {
      out.push(name);
    }
  }
  return out.sort();
}

function walkSorted(dir) {
  const acc = [];
  const rec = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) rec(path.join(d, e.name), rel);
      else if (e.isFile()) acc.push(rel);
      // symlink：跳过（迁移域不应有；出现即诊断而非跟随）
      else if (e.isSymbolicLink()) throw new Error(`symlink in migrate domain: ${path.join(d, e.name)}`);
    }
  };
  rec(dir, "");
  return acc;
}

/** 单文件 sha256（流式读，4M 块） */
export function sha256File(absPath) {
  const hash = createHash("sha256");
  const fd = fs.openSync(absPath, "r");
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** sqlite 表行数快照（只读打开；返回 {表名: 行数}，跳过 sqlite 内部表与 vec0 虚拟表
 *  ——虚拟表依赖扩展模块，裸连接（restore/verify 端）count 会报 no such module */
export function sqliteTableCounts(dbPath) {
  const Database = nodeRequire("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all();
    const counts = {};
    for (const r of rows) {
      if (r.sql && /USING\s+vec0/i.test(r.sql)) continue; // vec 虚拟表：内容随主表，行数校验不适用
      counts[r.name] = db.prepare(`SELECT count(*) AS c FROM "${r.name.replace(/"/g, '""')}"`).get().c;
    }
    return counts;
  } finally {
    db.close();
  }
}

/** better-sqlite3 经 createRequire 惰性加载（避免顶层 import 拖慢纯函数测试） */

/** sqlite 一致性备份（better-sqlite3 backup API：在线安全，含 WAL 合并语义） */
export async function sqliteBackup(srcDbPath, destDbPath) {
  const Database = nodeRequire("better-sqlite3");
  fs.mkdirSync(path.dirname(destDbPath), { recursive: true }); // backup API 不建目录（实测）
  const src = new Database(srcDbPath, { readonly: true, fileMustExist: true });
  try {
    await src.backup(destDbPath);
  } finally {
    src.close();
  }
}

/** 生成 manifest（对 staging 目录内的相对路径集计算 sha + 表行数） */
export async function buildManifest(dataDir, relFiles, sourceRoot) {
  const files = [];
  const databases = {};
  for (const rel of relFiles) {
    const abs = path.join(dataDir, rel);
    const size = fs.statSync(abs).size;
    files.push({ path: rel, size, sha256: sha256File(abs) });
    if (isSqliteFile(rel) && size > 0) {
      databases[rel] = { tables: sqliteTableCounts(abs) };
    }
  }
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    sourceRoot,
    files,
    databases,
    options: { includes: MIGRATE_INCLUDES },
  };
}

/** 三级校验（可独立重跑）：文件清单+大小+sha 全量，sqlite 表行数逐库逐表。
 *  返回 { ok, report }——report 含逐项结果与差异明细（供人读与 JSON 落档）。 */
export function verifyAgainstManifest(dataDir, manifest) {
  const diffs = [];
  const seen = new Set();
  for (const f of manifest.files) {
    const abs = path.join(dataDir, f.path);
    seen.add(f.path);
    if (!fs.existsSync(abs)) { diffs.push(`missing: ${f.path}`); continue; }
    const size = fs.statSync(abs).size;
    if (size !== f.size) { diffs.push(`size mismatch: ${f.path} (manifest ${f.size}, actual ${size})`); continue; }
    const sha = sha256File(abs);
    if (sha !== f.sha256) diffs.push(`sha256 mismatch: ${f.path}`);
  }
  // 多出的文件（restore 目录里 manifest 未登记的）——提示级不算失败？算（云端目录应与导出严格一致）
  for (const rel of collectMigrateFiles(dataDir)) {
    if (!seen.has(rel)) diffs.push(`extra file: ${rel}`);
  }
  // 表行数
  const tableDiffs = [];
  for (const [dbRel, meta] of Object.entries(manifest.databases)) {
    const abs = path.join(dataDir, dbRel);
    if (!fs.existsSync(abs)) { tableDiffs.push(`missing db: ${dbRel}`); continue; }
    const actual = sqliteTableCounts(abs);
    for (const [table, expected] of Object.entries(meta.tables)) {
      const got = actual[table] ?? -1;
      if (got !== expected) tableDiffs.push(`table count mismatch: ${dbRel}#${table} (manifest ${expected}, actual ${got})`);
    }
    for (const table of Object.keys(actual)) {
      if (!(table in meta.tables)) tableDiffs.push(`extra table: ${dbRel}#${table}`);
    }
  }
  return {
    ok: diffs.length === 0 && tableDiffs.length === 0,
    report: {
      verifiedAt: new Date().toISOString(),
      filesChecked: manifest.files.length,
      dbsChecked: Object.keys(manifest.databases).length,
      fileDiffs: diffs,
      tableDiffs,
    },
  };
}

/** 平台最优拷贝（clonefile/reflink 优先，真拷贝兜底）——大目录 staging 用 */
export function fastCopyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  try {
    execFileSync("cp", ["-c", "-R", src + "/", dest + "/"], { stdio: "pipe" }); // mac clonefile
  } catch {
    try {
      execFileSync("cp", ["--reflink=auto", "-a", src + "/", dest + "/"], { stdio: "pipe" }); // linux
    } catch {
      fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
    }
  }
}
