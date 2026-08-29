#!/usr/bin/env node
/**
 * RHI 快照回填 CLI：pnpm health:backfill [--days=30] [--db=...] [--dry-run]
 *
 * F20260829hviz Fix C：用真实 git 历史按天重算历史快照，让健康面板趋势图
 * 「立刻有内容」——不是造假数据，是对既有 commit 历史按当日窗口重放计算。
 *
 * 逐天循环调用 HealthReport.generate({ since, until, snapshotDate })：
 * - since = 当日往前 60 天（滚动窗口口径，与 scanOnce 的 metricsWindowDays 一致）
 * - until = 当日 23:59:59（只算到那天为止的提交，杜绝未来数据穿越）
 * - snapshotDate = 当日（同日覆盖，幂等可重跑）
 *
 * 注意：回填不写 chain_states 行（链构建是 worker 的实时管道，历史重建成本高）；
 * 当天运行 worker/手动扫描后自然补上。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");

function parseArgs(argv) {
  const args = { days: 30, db: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // --key=value 单参数形式
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      applyArg(args, arg.slice(0, eq), arg.slice(eq + 1));
      continue;
    }
    // --key value 空格分隔形式
    if (arg.startsWith("--")) {
      if (arg === "--dry-run") {
        args.dryRun = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        applyArg(args, arg, next);
        i++;
      } else {
        console.error(`[WARN] 参数 ${arg} 缺少取值，已忽略（支持 --key=value 或 --key value 两种形式）`);
      }
      continue;
    }
    console.error(`[WARN] 忽略无法识别的参数: ${arg}`);
  }
  return args;
}

function applyArg(args, key, value) {
  if (key === "--days" && value) args.days = Math.max(1, Math.min(365, Number(value)));
  else if (key === "--db" && value) args.db = value;
  else console.error(`[WARN] 忽略无法识别的参数: ${key}=${value}`);
}

const logger = {
  info: (msg, meta) => console.error(`[INFO] ${msg}`, meta ? JSON.stringify(meta) : ""),
  warn: (msg, meta) => console.error(`[WARN] ${msg}`, meta ? JSON.stringify(meta) : ""),
  error: (msg, err) => console.error(`[ERROR] ${msg}`, err?.message ?? err ?? ""),
};

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { HealthReport } = await import(path.join(rootDir, "dist/src/usecases/health/health-report.js"));
  const { initSchema } = await import(path.join(rootDir, "dist/src/frameworks/db/schema.js"));
  const Database = (await import("better-sqlite3")).default;

  const dbPath = args.db ?? process.env.OTTER_DB_PATH ?? path.join(rootDir, "data/otter-buddy.db");
  const db = new Database(dbPath);
  initSchema(db);

  const report = new HealthReport(rootDir, db, logger);
  const windowDays = 60; // 与 scanOnce metricsWindowDays 同口径

  const today = new Date();
  const days = args.days;
  let written = 0;

  try {
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
      const snapshotDate = fmtDate(day);
      const since = new Date(day.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
      const until = new Date(day.getTime() + 23 * 60 * 60 * 1000 + 59 * 60 * 1000 + 59 * 1000).toISOString();

      const { metrics } = await report.generate({
        format: "text",
        since,
        until,
        snapshotDate,
        ...(args.dryRun ? { skipPersistence: true } : {}),
      });
      written++;
      if (i === 0 || i === days - 1 || written % 10 === 0) {
        logger.info(`backfill ${snapshotDate}`, {
          totalCommits: metrics.totalCommits,
          bugfixRatio: Number(metrics.bugfixRatio.toFixed(3)),
        });
      }
    }
    console.error(`[INFO] Backfill done: ${written} days${args.dryRun ? " (dry-run, nothing written)" : ""} → ${dbPath}`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  console.error("[FATAL]", err?.message ?? err);
  process.exit(1);
});
