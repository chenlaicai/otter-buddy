import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { logger } from "@frameworks/logger";

export interface DatabaseConfig {
  path?: string;
  walMode?: boolean;
  foreignKeys?: boolean;
}

const defaultConfig: DatabaseConfig = {
  path: ":memory:",
  walMode: true,
  foreignKeys: true,
};

/**
 * 初始化数据库连接（同步）。
 * WAL 模式 + 外键约束 + sqlite-vec 扩展（失败降级为 FTS5-only，D22）。
 */
export function initDatabase(config?: DatabaseConfig): Database.Database {
  const merged = { ...defaultConfig, ...config };
  const db = new Database(merged.path ?? ":memory:");

  if (merged.walMode) {
    db.pragma("journal_mode = WAL");
  }

  if (merged.foreignKeys) {
    db.pragma("foreign_keys = ON");
  }

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
