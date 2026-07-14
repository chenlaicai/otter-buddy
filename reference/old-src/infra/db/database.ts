import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { logger } from "@infra/logger";

interface DatabaseConfig {
  dbPath: string;
  enableWal: boolean;
  enableForeignKeys: boolean;
}

const defaultConfig: DatabaseConfig = {
  dbPath: ":memory:",
  enableWal: true,
  enableForeignKeys: true,
};

/**
 * 初始化数据库连接（同步）
 * - 启用 WAL 模式（默认）
 * - 启用外键约束（默认）
 * - 尝试加载 sqlite-vec 扩展（失败仅 warn，不阻塞启动）
 */
export function initDatabase(config?: Partial<DatabaseConfig>): Database.Database {
  const merged = { ...defaultConfig, ...config };
  const db = new Database(merged.dbPath);

  if (merged.enableWal) {
    db.pragma("journal_mode = WAL");
  }

  if (merged.enableForeignKeys) {
    db.pragma("foreign_keys = ON");
  }

  // 尝试加载 sqlite-vec 扩展（D22 降级策略：失败仅 warn）
  try {
    loadSqliteVec(db);
  } catch {
    logger.warn("sqlite-vec 加载失败，降级为纯 FTS5 检索");
  }

  return db;
}

/** 关闭数据库连接 */
export function closeDatabase(db: Database.Database): void {
  db.close();
}
