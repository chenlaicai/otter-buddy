import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import type { Logger } from "@usecases/ports/logger";

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
export function initDatabase(config?: DatabaseConfig, logger?: Logger): Database.Database {
  const merged = { ...defaultConfig, ...config };
  const db = new Database(merged.path ?? ":memory:");

  if (merged.walMode) {
    db.pragma("journal_mode = WAL");
  }

  if (merged.foreignKeys) {
    db.pragma("foreign_keys = ON");
  }

  let sqliteVecLoaded = false;
  try {
    loadSqliteVec(db);
    sqliteVecLoaded = true;
  } catch {
    if (logger) {
      logger.warn("sqlite-vec 加载失败，降级为纯 FTS5 检索");
    }
  }

  // 记录数据库初始化日志
  if (logger) {
    logger.info('Database initialized', {
      path: merged.path,
      walMode: merged.walMode,
      foreignKeys: merged.foreignKeys,
      sqliteVec: sqliteVecLoaded,
    });
  }

  return db;
}

/** 关闭数据库连接 */
export function closeDatabase(db: Database.Database, logger?: Logger): void {
  // 记录数据库关闭日志
  if (logger) {
    logger.debug('Database closing');
  }

  db.close();
}
