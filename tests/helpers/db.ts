/**
 * 共享测试 DB 工厂。
 *
 * 所有需要 sqlite 的测试一律用本工厂，禁止手写 DDL——
 * 手写 CREATE TABLE 会与生产 schema 静默漂移（曾发生于 memory 测试）。
 */
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { createTestLogger } from "./logger";

/**
 * 创建内存 sqlite 并初始化完整生产 schema。调用方负责 afterEach 中 db.close()。
 * initSchema 只建基础表结构；历史补丁列（session_file、model_alias 等）由
 * migrateDatabase（幂等）补齐——与生产 fresh-DB 路径（F20260805fmdb 修复后）一致。
 *
 * 与生产 initDatabase（src/frameworks/db/database.ts）对齐：加载 sqlite-vec。
 * 不加载则 memory_vec 不存在、vec 路径测试静默零覆盖且无信号（#944 现场：
 * 特性文档写「vec 键替换已验证」，实际测试库根本没有这张表）。
 * 加载失败直接抛——测试环境必须能加载 vec；生产 D22 降级是生产容错，
 * 不是测试默认形态。
 */
export function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  loadSqliteVec(db);
  initSchema(db);
  migrateDatabase(db, createTestLogger());
  return db;
}
