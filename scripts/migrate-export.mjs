#!/usr/bin/env node
/* global URL, AbortSignal */
/**
 * 迁移导出（阶段 6b）：停源一致性导出 → manifest（sha256 + 表行数）→ tar.gz 产物。
 *
 * 用法（本机，主服务停止后）：
 *   node scripts/migrate-export.mjs [--out <dir>] [--skip-liveness]
 * 产物：
 *   <out>/migrate-<时间戳>.tar.gz     —— 数据域一致性副本打包（gzip -1 快速档）
 *   <out>/migrate-<时间戳>.manifest.json —— 校验基准（旁置副本；tar 内也含一份）
 *
 * 停源 fail-closed：探测 127.0.0.1:3000 /api/ping——服务在跑即拒绝导出
 * （防活库快照不一致；--skip-liveness 为调试逃生口，产物会打上非一致性标记）。
 *
 * 一致性实现：sqlite 文件走 better-sqlite3 backup API（WAL 合并语义）落 staging；
 * 其余目录 clonefile/reflink 优先拷贝。manifest 对 staging 计算（与产物严格一致）。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  collectMigrateFiles, buildManifest, sqliteBackup, fastCopyDir,
} from "./migrate-lib.mjs";

const args = process.argv.slice(2);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const skipLiveness = args.includes("--skip-liveness");
const outIdx = args.indexOf("--out");
const outDir = outIdx !== -1 ? path.resolve(args[outIdx + 1]) : path.resolve("data/backups/migrate");
const dataIdx = args.indexOf("--data-dir");
const dataDir = dataIdx !== -1 ? path.resolve(args[dataIdx + 1]) : path.join(repoRoot, "data");

async function serviceAlive() {
  try {
    const res = await fetch("http://127.0.0.1:3000/api/ping", { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (!skipLiveness && await serviceAlive()) {
    console.error("[migrate-export] 主服务仍在运行（127.0.0.1:3000 /api/ping 可达）——");
    console.error("  活库快照可能不一致。先停服（systemctl stop / Ctrl-C 主进程）再导出。");
    console.error("  调试逃生口：--skip-liveness（产物 manifest 会标记 assumed-consistent=false）");
    process.exit(1);
  }

  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  fs.mkdirSync(outDir, { recursive: true });
  const staging = path.join(outDir, `.staging-${ts}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const relFiles = collectMigrateFiles(dataDir);
  if (relFiles.length === 0) {
    console.error(`[migrate-export] 迁移域为空——${dataDir} 缺失或路径不对？`);
    process.exit(1);
  }
  const sqliteFiles = relFiles.filter((r) => r === "otter-buddy.db" || r.startsWith("durable-sessions/"));
  const plainFiles = relFiles.filter((r) => !sqliteFiles.includes(r));
  console.log(`[migrate-export] 域内 ${relFiles.length} 文件（sqlite ${sqliteFiles.length} / 普通 ${plainFiles.length}）`);

  // 普通（非 sqlite）项：clone/reflink 拷入 staging
  for (const rel of plainFiles) {
    const srcAbs = path.join(dataDir, rel);
    const dstAbs = path.join(staging, rel);
    const stat = fs.statSync(srcAbs);
    if (stat.isDirectory()) fastCopyDir(srcAbs, dstAbs);
    else { fs.mkdirSync(path.dirname(dstAbs), { recursive: true }); fs.copyFileSync(srcAbs, dstAbs); }
  }
  // sqlite 项：backup API 一致性落 staging
  let done = 0;
  for (const rel of sqliteFiles) {
    await sqliteBackup(path.join(dataDir, rel), path.join(staging, rel));
    done += 1;
    if (done % 50 === 0 || done === sqliteFiles.length) console.log(`[migrate-export] sqlite backup ${done}/${sqliteFiles.length}`);
  }

  // manifest 对 staging 计算（tar 内容与校验基准严格同源）
  const manifest = await buildManifest(staging, relFiles, dataDir);
  manifest.assumedConsistent = !skipLiveness;
  const manifestPath = path.join(outDir, `migrate-${ts}.manifest.json`);
  fs.writeFileSync(path.join(staging, "MIGRATE-MANIFEST.json"), JSON.stringify(manifest, null, 2));

  // 打包（gzip -1：12G 量级压缩耗时与体积折中）
  const tarPath = path.join(outDir, `migrate-${ts}.tar.gz`);
  execFileSync("tar", ["-czf", tarPath, "-C", staging, "."], { stdio: "inherit" });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  fs.rmSync(staging, { recursive: true, force: true });
  const sizeGb = (fs.statSync(tarPath).size / 1024 ** 3).toFixed(2);
  console.log(`[migrate-export] 完成：${tarPath}（${sizeGb} GB）`);
  console.log(`[migrate-export] manifest：${manifestPath}（files ${manifest.files.length} / dbs ${Object.keys(manifest.databases).length}）`);
}

main().catch((err) => { console.error("[migrate-export] 失败：", err); process.exit(1); });
