#!/usr/bin/env node
/* global URL, AbortSignal */
/**
 * 迁移导出（阶段 6b）：停源一致性导出 → manifest（sha256/target + 表行数）→ tar.gz 产物。
 *
 * 用法（本机，主服务停止后）：
 *   node scripts/migrate-export.mjs [--out <dir>] [--data-dir <dir>] [--ping-port <n>] [--skip-liveness]
 * 产物：
 *   <out>/migrate-<时间戳>.tar.gz     —— 数据域一致性副本打包（gzip -1 快速档）
 *   <out>/migrate-<时间戳>.manifest.json —— 校验基准（旁置副本；tar 内也含一份）
 *
 * 停源 fail-closed：探测 127.0.0.1:<ping-port> /api/ping——服务在跑即拒绝导出
 * （防活库快照不一致；--skip-liveness 为调试/演练逃生口，产物标记 assumedConsistent=false，
 *  restore/verify 消费时会打醒目警告）。
 *
 * 一致性实现：sqlite 主库文件走 better-sqlite3 backup API（WAL 合并语义）落 staging；
 * WAL 伴生（-shm/-wal）不迁（shm 是重建产物、wal 内容已被 backup 合并）；
 * symlink 原样保留（不跟随，绝对路径链接迁过去指向本机路径属预期无害）；
 * socket/FIFO 等特殊文件跳过（运行时产物）。manifest 对 staging 计算（与产物严格同源）。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  collectMigrateEntries, buildManifest, sqliteBackup, isSqliteFile, volumeFreeBytes,
} from "./migrate-lib.mjs";

const args = process.argv.slice(2);
const pingPortIdx = args.indexOf("--ping-port");
const pingPort = pingPortIdx !== -1 ? Number(args[pingPortIdx + 1]) : 3000;
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const skipLiveness = args.includes("--skip-liveness");
const outIdx = args.indexOf("--out");
const outDir = outIdx !== -1 ? path.resolve(args[outIdx + 1]) : path.resolve("data/backups/migrate");
const dataIdx = args.indexOf("--data-dir");
const dataDir = dataIdx !== -1 ? path.resolve(args[dataIdx + 1]) : path.join(repoRoot, "data");

async function serviceAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${pingPort}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (!skipLiveness && await serviceAlive()) {
    console.error(`[migrate-export] 主服务仍在运行（127.0.0.1:${pingPort} /api/ping 可达）——`);
    console.error("  活库快照可能不一致。先停服（systemctl stop / Ctrl-C 主进程）再导出。");
    console.error("  调试逃生口：--skip-liveness（产物 manifest 会标记 assumedConsistent=false）");
    process.exit(1);
  }

  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  fs.mkdirSync(outDir, { recursive: true });
  const staging = path.join(outDir, `.staging-${ts}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const entries = collectMigrateEntries(dataDir);
  if (entries.length === 0) {
    console.error(`[migrate-export] 迁移域为空——${dataDir} 缺失或路径不对？`);
    process.exit(1);
  }
  const sqliteEntries = entries.filter((e) => e.type === "file" && isSqliteFile(e.rel));
  const symlinkCount = entries.filter((e) => e.type === "symlink").length;
  console.log(`[migrate-export] 域内 ${entries.length} 条目（sqlite ${sqliteEntries.length} / symlink ${symlinkCount} / 普通文件 ${entries.length - sqliteEntries.length - symlinkCount}）`);

  // 磁盘预检：staging（≈数据量）与 tar.gz（估 60%）需同卷并存
  const freeBytes = volumeFreeBytes(outDir);
  if (freeBytes !== null) {
    let payload = 0;
    for (const e of entries) {
      if (e.type === "file") payload += fs.statSync(path.join(dataDir, e.rel)).size;
    }
    const needBytes = payload * 1.6;
    if (needBytes > freeBytes) {
      console.error(`[migrate-export] 磁盘预检不过：staging+tar 峰值约需 ${(needBytes / 1024 ** 3).toFixed(1)} GB > ${(freeBytes / 1024 ** 3).toFixed(1)} GB 可用（${outDir} 所在卷）`);
      console.error("  处置：--out 指向余量更大的卷，或先清理该卷。");
      process.exit(1);
    }
    console.log(`[migrate-export] 磁盘预检过：数据 ${(payload / 1024 ** 3).toFixed(1)} GB，峰值约 ${(needBytes / 1024 ** 3).toFixed(1)} GB / 可用 ${(freeBytes / 1024 ** 3).toFixed(1)} GB`);
  }

  // staging 落盘：普通目录整目录 clone（排除 sqlite/symlink 单独处理）+ 顶层散文件
  const topNames = new Set(entries.map((e) => (e.rel.includes("/") ? e.rel.split("/")[0] : e.rel)));
  for (const name of topNames) {
    const srcAbs = path.join(dataDir, name);
    const dstAbs = path.join(staging, name);
    const lstat = fs.lstatSync(srcAbs);
    if (lstat.isDirectory()) {
      // 目录内 sqlite 文件与 WAL 伴生不整拷：排除后逐条目处理
      fs.mkdirSync(dstAbs, { recursive: true });
      copyDirExcluding(srcAbs, dstAbs, (rel) => isSqliteFile(`${name}/${rel}`) || `${name}/${rel}`.endsWith(".sqlite-shm") || `${name}/${rel}`.endsWith(".sqlite-wal"));
    } else if (lstat.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(srcAbs), dstAbs);
    } else if (!isSqliteFile(name)) {
      fs.copyFileSync(srcAbs, dstAbs); // 顶层 sqlite 主库跳过——由下方 backup 段一致性处理（防双拷）
    }
  }
  // sqlite 逐库 backup（一致性；目标目录 sqliteBackup 自建）
  let done = 0;
  for (const e of sqliteEntries) {
    await sqliteBackup(path.join(dataDir, e.rel), path.join(staging, e.rel));
    done += 1;
    if (done % 50 === 0 || done === sqliteEntries.length) console.log(`[migrate-export] sqlite backup ${done}/${sqliteEntries.length}`);
  }

  // manifest 对 staging 计算（tar 内容与校验基准严格同源；此刻 staging 尚无 MIGRATE-MANIFEST.json）
  const manifest = await buildManifest(staging, collectMigrateEntries(staging), dataDir);
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
  console.log("[migrate-export] 传输到 ECS 后记得在还原校验通过时删除 tar 释放磁盘（见 migrate-runbook.md）");
}

/** 目录拷贝（排除谓词命中的相对路径；symlink 原样；socket 跳过） */
function copyDirExcluding(srcDir, dstDir, excludeRel) {
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, e.name);
    const dst = path.join(dstDir, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyDirExcluding(src, dst, excludeRel);
    } else if (e.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(src), dst);
    } else if (e.isFile()) {
      const rel = path.relative(srcDir, src);
      if (!excludeRel(rel)) fs.copyFileSync(src, dst);
    }
    // socket/FIFO：跳过
  }
}

main().catch((err) => { console.error("[migrate-export] 失败：", err); process.exit(1); });
