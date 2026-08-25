#!/usr/bin/env node

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

async function main() {
  try {
    // 导入编译后的模块
    const { HealthReport } = await import(path.join(rootDir, "dist/src/usecases/health/health-report.js"));
    const { initSchema } = await import(path.join(rootDir, "dist/src/frameworks/db/schema.js"));
    const Database = (await import("better-sqlite3")).default;

    // 创建数据库连接
    const dbPath = path.join(rootDir, "data/otter.db");
    const db = new Database(dbPath);

    // 初始化 schema
    initSchema(db);

    // 创建文件系统网关（简化版）
    const fs = {
      async readFile(filePath) {
        const fsModule = await import("fs/promises");
        return fsModule.readFile(filePath, "utf-8");
      },
      async readDir(dirPath) {
        const fsModule = await import("fs/promises");
        return fsModule.readdir(dirPath, { withFileTypes: true });
      },
      async exists(filePath) {
        const fsModule = await import("fs/promises");
        try {
          await fsModule.access(filePath);
          return true;
        } catch {
          return false;
        }
      },
    };

    // 创建日志记录器（简化版）
    const logger = {
      info: (message, meta) => console.log(`[INFO] ${message}`, meta || ""),
      warn: (message, meta) => console.warn(`[WARN] ${message}`, meta || ""),
      error: (message, error, meta) => console.error(`[ERROR] ${message}`, error?.message || error, meta || ""),
    };

    // 创建健康报告实例
    const healthReport = new HealthReport(db, fs, rootDir, logger);

    // 解析命令行参数
    const args = process.argv.slice(2);
    const format = args.find(arg => arg.startsWith("--format="))?.split("=")[1] || "both";
    const outputPath = args.find(arg => arg.startsWith("--output="))?.split("=")[1];

    // 生成报告
    if (outputPath) {
      await healthReport.outputToFile(path.resolve(outputPath), { format });
    } else {
      await healthReport.outputToConsole({ format });
    }

    // 关闭数据库
    db.close();
  } catch (error) {
    console.error("Failed to generate health report:", error.message);
    process.exit(1);
  }
}

main();
