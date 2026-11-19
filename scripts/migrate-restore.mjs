#!/usr/bin/env node
/**
 * 迁移还原：解包 tar 产物到目标数据目录 → 内置三级校验。
 *
 * 用法（云端 ECS 或本机演练目标目录）：
 *   node scripts/migrate-restore.mjs --tar <migrate-*.tar.gz> --data-dir <目标data目录> [--allow-overwrite]
 * 语义：
 *   - 目标目录默认必须为空（防误覆盖既有数据；--allow-overwrite 显式解锁覆盖）
 *   - 解包前磁盘预检：解压后数据量 vs 目标卷剩余，不足即拒
 *   - assumedConsistent=false（演练/跳过停源检查的产物）打醒目警告
 *   - 解包后自动三级校验（tar 内 MIGRATE-MANIFEST.json 为基准）；
 *     不过 exit 1（现场保留供诊断，不自动回滚）
 *   - 校验通过后提示删除 tar 释放磁盘（ECS 小盘红线）
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyAgainstManifest, manifestPayloadBytes, volumeFreeBytes } from "./migrate-lib.mjs";

const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(name);
  if (i === -1 || !args[i + 1]) { console.error(`缺少参数 ${name}`); process.exit(2); }
  return path.resolve(args[i + 1]);
}
const tarPath = argOf("--tar");
const dataDir = argOf("--data-dir");
const allowOverwrite = args.includes("--allow-overwrite");

fs.mkdirSync(dataDir, { recursive: true });
if (!allowOverwrite && fs.readdirSync(dataDir).length > 0) {
  console.error("[migrate-restore] 目标目录非空——默认拒绝（防误覆盖既有数据）。");
  console.error("  确认覆盖语义请显式加 --allow-overwrite（tar 将覆盖同名文件）。");
  process.exit(1);
}

// manifest 预读（tar 内副本取出：tar -xO 流式读，不落盘）
const manifestJson = execFileSync("tar", ["-xzOf", tarPath, "./MIGRATE-MANIFEST.json"], { maxBuffer: 64 * 1024 * 1024 }).toString("utf-8");
const manifest = JSON.parse(manifestJson);

if (manifest.assumedConsistent === false) {
  console.warn("==============================================================");
  console.warn("[migrate-restore] ⚠️ 该产物导出时跳过了停源检查（assumedConsistent=false）——");
  console.warn("  可能是活库快照（WAL 期间数据漂移）。演练用途可继续；真切云端必须用停源产物。");
  console.warn("==============================================================");
}

// 磁盘预检：解压数据量（+10% 余量）vs 目标卷剩余（tar 本身已占的空间含在剩余里）
const payload = manifestPayloadBytes(manifest);
const free = volumeFreeBytes(dataDir);
if (free !== null && payload * 1.1 > free) {
  console.error(`[migrate-restore] 磁盘预检不过：解压数据 ${(payload / 1024 ** 3).toFixed(1)} GB（+10% 余量）> 可用 ${(free / 1024 ** 3).toFixed(1)} GB`);
  console.error("  处置：清理目标卷（如删除已校验过的旧产物），或迁移产物到更大卷再解。");
  process.exit(1);
}

console.log(`[migrate-restore] 解包 ${tarPath} → ${dataDir}（数据 ${(payload / 1024 ** 3).toFixed(1)} GB / 可用 ${free === null ? "?" : (free / 1024 ** 3).toFixed(1)} GB）`);
execFileSync("tar", ["-xzf", tarPath, "-C", dataDir], { stdio: "inherit" });

const { ok, report } = verifyAgainstManifest(dataDir, manifest);
fs.writeFileSync(path.join(dataDir, "..", "migrate-restore-report.json"), JSON.stringify(report, null, 2));
if (ok) {
  console.log(`[migrate-restore] 三级校验通过：files ${report.filesChecked} / dbs ${report.dbsChecked}`);
  console.log(`[migrate-restore] 提示：校验已过，请删除 tar 释放磁盘——rm ${tarPath}（约 ${(fs.statSync(tarPath).size / 1024 ** 3).toFixed(1)} GB，ECS 小盘红线）`);
  console.log("[migrate-restore] 还原完成（报告：migrate-restore-report.json）");
} else {
  console.error("[migrate-restore] 校验失败（现场保留供诊断）：");
  for (const d of [...report.fileDiffs, ...report.tableDiffs].slice(0, 20)) console.error(`  - ${d}`);
  process.exit(1);
}
