/**
 * 共享测试 DB 工厂。
 *
 * 所有需要 sqlite 的测试一律用本工厂，禁止手写 DDL——
 * 手写 CREATE TABLE 会与生产 schema 静默漂移（曾发生于 memory 测试）。
 */
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { createTestLogger } from "./logger";

/**
 * 创建内存 sqlite 并初始化完整生产 schema。调用方负责 afterEach 中 db.close()。
 * initSchema 只建基础表结构；历史补丁列（session_file、model_alias 等）由
 * migrateDatabase（幂等）补齐——与生产 fresh-DB 路径（F20260805fmdb 修复后）一致。
 */
export function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  migrateDatabase(db, createTestLogger());
  return db;
}
