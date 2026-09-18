#!/usr/bin/env node
/* global URL, Buffer */ // eslint no-undef：Node 全局在 .mjs 下需显式声明
/**
 * data/ 运行时数据备份（#1038）
 *
 * 背景：data/metrics（含 golden-results.jsonl 执行历史）gitignore、无备份，
 * 2026-09-17 一条误删命令整目录丢失、不可恢复。本脚本是防误删双重措施的兜底层：
 *   - 措施 1（拦截）：bash-safety-guard 拦截指向主仓 data/ 的 rm/mv/find -delete
 *   - 措施 2（正向）：验证操作走 alpha.sh 隔离实例 / worktree，碰不到主仓 data/
 *   - 兜底（本脚本）：即使前两层失效（如人工误操作），备份可恢复
 *
 * 备份范围：
 *   - data/metrics/ 全量（小而珍贵：日粒度 JSONL + golden 执行历史，~20M）
 *   - data/logs/otter-buddy.log 尾部 32M（单文件 288M，全备不现实）
 *
 * 用法：
 *   node scripts/backup-runtime-data.mjs                # 默认保留 14 天
 *   KEEP_DAYS=30 node scripts/backup-runtime-data.mjs  # 自定义保留期
 *
 * 退出码：0=成功或无可备份；1=失败（供调度方告警）。
 * 产物：data/backups/runtime-<时间戳>.tar.gz（原子写：先 .tmp 后 rename）
 * 实现说明：staging 目录放 symlink（metrics）+ 实体（日志尾部），tar -h 跟随
 * symlink 打包——BSD/GNU tar 通吃，不依赖 GNU --transform。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const KEEP_DAYS = Number(process.env.KEEP_DAYS ?? 14);
if (!Number.isInteger(KEEP_DAYS) || KEEP_DAYS < 1) {
  console.error(`[backup] KEEP_DAYS 非法：${KEEP_DAYS}（需 ≥1 整数）`);
  process.exit(1);
}

const LOG_TAIL_BYTES = 32 * 1024 * 1024; // 日志尾部 32M
const KEEP_RE = /^runtime-\d{8}T\d{6}Z\.tar\.gz$/;

// 仓库根：脚本位于 <repo>/scripts/，无论从哪个 cwd 调起都锚定仓库根
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
// ↑ URL 声明见文件头 eslint global 注释
const dataDir = path.join(repoRoot, "data");
const metricsDir = path.join(dataDir, "metrics");
const logFile = path.join(dataDir, "logs", "otter-buddy.log");
const backupDir = path.join(dataDir, "backups");

/** 日志尾部复制到目标路径（≤32M 全量复制；>32M 取尾部，首行可能截半，可接受） */
function copyLogTail(dest) {
  if (!fs.existsSync(logFile)) return;
  const stat = fs.statSync(logFile);
  if (stat.size <= LOG_TAIL_BYTES) {
    fs.copyFileSync(logFile, dest);
    return;
  }
  const fd = fs.openSync(logFile, "r");
  try {
    const buf = Buffer.alloc(LOG_TAIL_BYTES);
    fs.readSync(fd, buf, 0, LOG_TAIL_BYTES, stat.size - LOG_TAIL_BYTES);
    fs.writeFileSync(dest, buf);
  } finally {
    fs.closeSync(fd);
  }
}

function main() {
  if (!fs.existsSync(metricsDir)) {
    console.log(`[backup] metrics 目录不存在（可能是新环境），跳过本次备份`);
    process.exit(0);
  }

  fs.mkdirSync(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.-]/g, "").slice(0, 13) + "Z"; // 20260918T003500Z
  const finalPath = path.join(backupDir, `runtime-${stamp}.tar.gz`);
  const tmpPath = `${finalPath}.tmp`;

  const stageDir = fs.mkdtempSync(path.join(backupDir, ".stage-"));
  try {
    // staging：data/metrics → symlink（tar -h 跟随）；logs 实体
    fs.mkdirSync(path.join(stageDir, "data"), { recursive: true });
    fs.symlinkSync(metricsDir, path.join(stageDir, "data", "metrics"), "dir");
    fs.mkdirSync(path.join(stageDir, "data", "logs"), { recursive: true });
    copyLogTail(path.join(stageDir, "data", "logs", "otter-buddy.log.tail"));

    // -h：跟随 symlink 打包实际内容（BSD/GNU tar 通吃）
    execFileSync("tar", ["-czf", tmpPath, "-h", "-C", stageDir, "data"], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    fs.renameSync(tmpPath, finalPath);

    const size = fs.statSync(finalPath).size;
    const sha = createHash("sha256").update(fs.readFileSync(finalPath)).digest("hex").slice(0, 16);
    console.log(`[backup] ✅ ${path.basename(finalPath)} (${(size / 1024 / 1024).toFixed(1)}M, sha256:${sha}…)`);
  } catch (err) {
    console.error(`[backup] ❌ 备份失败：${err instanceof Error ? err.message : err}`);
    process.exit(1);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.rmSync(tmpPath, { force: true });
  }

  // 清理过期备份
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let cleaned = 0;
  for (const f of fs.readdirSync(backupDir)) {
    if (!KEEP_RE.test(f)) continue;
    const full = path.join(backupDir, f);
    if (fs.statSync(full).mtimeMs < cutoff) {
      fs.unlinkSync(full);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`[backup] 清理 ${cleaned} 个过期备份（>${KEEP_DAYS}天）`);
}

main();
