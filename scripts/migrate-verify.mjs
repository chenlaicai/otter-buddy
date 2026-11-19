#!/usr/bin/env node
/**
 * 迁移校验（阶段 6b）：对已还原（或已运行）的数据目录独立重跑三级校验。
 *
 * 用法：
 *   node scripts/migrate-verify.mjs --data-dir <目录> --manifest <manifest.json> [--report <out.json>]
 * 三级：文件清单+大小+sha256 全量；sqlite 表行数逐库逐表；目录内多余文件检测。
 * 供切流后健康巡检与回退前快照比对复用（幂等，可反复执行）。
 */
import fs from "node:fs";
import path from "node:path";
import { verifyAgainstManifest } from "./migrate-lib.mjs";

const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(name);
  if (i === -1 || !args[i + 1]) { console.error(`缺少参数 ${name}`); process.exit(2); }
  return path.resolve(args[i + 1]);
}
const dataDir = argOf("--data-dir");
const manifestPath = argOf("--manifest");
const reportIdx = args.indexOf("--report");
const reportPath = reportIdx !== -1 ? path.resolve(args[reportIdx + 1]) : path.join(dataDir, "..", "migrate-verify-report.json");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
const { ok, report } = verifyAgainstManifest(dataDir, manifest);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

if (ok) {
  console.log(`[migrate-verify] 通过：files ${report.filesChecked} / dbs ${report.dbsChecked}（报告 ${reportPath}）`);
} else {
  console.error(`[migrate-verify] 失败（报告 ${reportPath}）：`);
  for (const d of [...report.fileDiffs, ...report.tableDiffs].slice(0, 20)) console.error(`  - ${d}`);
  process.exit(1);
}
