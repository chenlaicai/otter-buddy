#!/usr/bin/env node
/**
 * 存量 session 退化内容清洗脚本（F20260804dglp 修复 4）。
 *
 * 用法：
 *   node scripts/sanitize-sessions.mjs [--dir <session目录>]          # dry-run：只报告，不写盘
 *   node scripts/sanitize-sessions.mjs [--dir <session目录>] --apply  # 实际清洗（每个文件留 .bak）
 *
 * 前提：必须先停止服务（或确保目标 otter 无活跃 invoke）。
 * SDK 稳态写入是 appendFileSync 追加，清洗是全量读-改-写，运行中执行会丢 entry。
 *
 * 依赖 dist/ 已构建（npm run build）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { sanitizeSessionFile } = await import(path.join(root, "dist/src/frameworks/agent/session-sanitizer.js"));

const dirIdx = process.argv.indexOf("--dir");
const sessionDir = dirIdx >= 0 ? path.resolve(process.argv[dirIdx + 1]) : path.join(root, "data/sessions");
const apply = process.argv.includes("--apply");

if (!apply) {
  console.log("[dry-run] 只报告不清洗；加 --apply 实际执行（执行前必须停服）\n");
}

const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
let totalHits = 0;
let totalFiles = 0;

for (const f of files) {
  const fp = path.join(sessionDir, f);
  if (!apply) {
    /** dry-run：复制到临时文件清洗，看结果后丢弃（异常也保证清理临时文件） */
    const tmp = fp + ".dryrun-tmp";
    fs.copyFileSync(fp, tmp);
    let r;
    try {
      r = sanitizeSessionFile(tmp);
    } finally {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(tmp + ".bak", { force: true });
    }
    if (r.replacedBlocks > 0) {
      totalFiles++;
      totalHits += r.replacedBlocks;
      console.log(`${f}: ${r.replacedBlocks} 块（扫描 ${r.scannedEntries} entry）`);
      for (const h of r.hits) {
        console.log(`  - ${h.entryId.slice(0, 8)} ${h.blockType} ${(h.originalLength / 1024).toFixed(0)}KB ${h.mechanism}`);
      }
    }
  } else {
    const r = sanitizeSessionFile(fp);
    if (r.replacedBlocks > 0) {
      totalFiles++;
      totalHits += r.replacedBlocks;
      console.log(`${f}: 清洗 ${r.replacedBlocks} 块（.bak 已备份）`);
      for (const h of r.hits) {
        console.log(`  - ${h.entryId.slice(0, 8)} ${h.blockType} ${(h.originalLength / 1024).toFixed(0)}KB ${h.mechanism}`);
      }
    }
  }
}

console.log(`\n共 ${files.length} 个 session 文件，${totalFiles} 个含退化内容，命中 ${totalHits} 块`);
if (totalHits > 0 && !apply) {
  console.log("确认停服后执行：node scripts/sanitize-sessions.mjs --apply");
}
