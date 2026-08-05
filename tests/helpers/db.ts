/**
 * 共享测试 DB 工厂。
 *
 * 所有需要 sqlite 的测试一律用本工厂，禁止手写 DDL——
 * 手写 CREATE TABLE 会与生产 schema 静默漂移（曾发生于 memory 测试）。
 */
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";

/** 创建内存 sqlite 并初始化完整生产 schema。调用方负责 afterEach 中 db.close()。 */
export function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}
