#!/usr/bin/env node
/**
 * 迁移还原（阶段 6b）：解包 tar 产物到目标数据目录 → 内置三级校验。
 *
 * 用法（云端 ECS 或本机演练目标目录）：
 *   node scripts/migrate-restore.mjs --tar <migrate-*.tar.gz> --data-dir <目标data目录>
 * 语义：
 *   - 目标目录已有同名文件会被覆盖（tar 解包语义）；--require-empty 则要求目标为空
 *   - 解包后自动跑 verifyAgainstManifest（tar 内 MIGRATE-MANIFEST.json 为基准）；
 *     校验不过 exit 1（部分还原状态保留现场供诊断，不自动回滚）
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyAgainstManifest } from "./migrate-lib.mjs";

const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(name);
  if (i === -1 || !args[i + 1]) { console.error(`缺少参数 ${name}`); process.exit(2); }
  return path.resolve(args[i + 1]);
}
const tarPath = argOf("--tar");
const dataDir = argOf("--data-dir");
const requireEmpty = args.includes("--require-empty");

fs.mkdirSync(dataDir, { recursive: true });
if (requireEmpty && fs.readdirSync(dataDir).length > 0) {
  console.error("[migrate-restore] 目标目录非空且指定 --require-empty——拒绝");
  process.exit(1);
}

console.log(`[migrate-restore] 解包 ${tarPath} → ${dataDir}`);
execFileSync("tar", ["-xzf", tarPath, "-C", dataDir], { stdio: "inherit" });

const manifestPath = path.join(dataDir, "MIGRATE-MANIFEST.json");
if (!fs.existsSync(manifestPath)) {
  console.error("[migrate-restore] 产物缺 MIGRATE-MANIFEST.json——不是本工具的产物或损坏");
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

const { ok, report } = verifyAgainstManifest(dataDir, manifest);
fs.writeFileSync(path.join(dataDir, "..", "migrate-restore-report.json"), JSON.stringify(report, null, 2));
if (ok) {
  console.log(`[migrate-restore] 三级校验通过：files ${report.filesChecked} / dbs ${report.dbsChecked}`);
  console.log("[migrate-restore] 还原完成（报告：migrate-restore-report.json）");
} else {
  console.error("[migrate-restore] 校验失败（现场保留供诊断）：");
  for (const d of [...report.fileDiffs, ...report.tableDiffs].slice(0, 20)) console.error(`  - ${d}`);
  process.exit(1);
}
