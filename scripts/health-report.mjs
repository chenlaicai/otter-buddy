#!/usr/bin/env node
/**
 * RHI CLI 入口：pnpm health:report
 *
 * 用法：
 *   pnpm health:report                    # JSON + 文本双输出
 *   pnpm health:report --format=json     # 仅 JSON（agent 消费通道）
 *   pnpm health:report --format=text     # 仅文本
 *   pnpm health:report --output=report.txt
 *   pnpm health:report --since=2026-07-08 --max-count=100
 */

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");

function parseArgs(argv) {
  const args = { format: "both", output: undefined, since: undefined, until: undefined, maxCount: undefined };
  for (const arg of argv) {
    const [key, ...rest] = arg.split("=");
    const value = rest.join("=");
    if (key === "--format" && ["json", "text", "both"].includes(value)) args.format = value;
    else if (key === "--output" && value) args.output = value;
    else if (key === "--since" && value) args.since = value;
    else if (key === "--until" && value) args.until = value;
    else if (key === "--max-count" && value) args.maxCount = Number(value);
  }
  return args;
}

const logger = {
  info: (msg, meta) => console.error(`[INFO] ${msg}`, meta ? JSON.stringify(meta) : ""),
  warn: (msg, meta) => console.error(`[WARN] ${msg}`, meta ? JSON.stringify(meta) : ""),
  error: (msg, err) => console.error(`[ERROR] ${msg}`, err?.message ?? err ?? ""),
};

async function main() {
  const { HealthReport } = await import(path.join(rootDir, "dist/src/usecases/health/health-report.js"));
  const { initSchema } = await import(path.join(rootDir, "dist/src/frameworks/db/schema.js"));
  const Database = (await import("better-sqlite3")).default;

  // 数据库路径：环境变量优先，默认 data/otter-buddy.db（与服务运行时同库；
  // F20260829hviz Fix B：曾默认废弃的 data/otter.db，导致指标写进孤儿库、面板永远读不到）
  const dbPath = process.env.OTTER_DB_PATH ?? path.join(rootDir, "data/otter-buddy.db");
  const db = new Database(dbPath);
  initSchema(db);

  const args = parseArgs(process.argv.slice(2));
  const report = new HealthReport(rootDir, db, logger);

  try {
    const { report: content } = await report.generate({
      format: args.format,
      since: args.since,
      until: args.until,
      maxCount: args.maxCount,
    });

    if (args.output) {
      const outPath = path.resolve(args.output);
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, content, "utf-8");
      console.error(`[INFO] Report written to ${outPath}`);
    } else {
      process.stdout.write(content + "\n");
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("[FATAL]", err?.message ?? err);
  process.exit(1);
});
