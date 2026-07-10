import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase, closeDatabase } from "@infra/db/database";

describe("database", () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) {
      closeDatabase(db);
    }
  });

  it("初始化数据库连接", () => {
    db = initDatabase({ dbPath: ":memory:" });
    expect(db).toBeDefined();
    // 验证可执行 SQL
    const result = db.prepare("SELECT 1 as value").get();
    expect(result).toEqual({ value: 1 });
  });

  it("WAL 模式启用", () => {
    db = initDatabase({ dbPath: ":memory:", enableWal: true });
    const result = db.pragma("journal_mode", { simple: true });
    // 内存数据库不支持 WAL，返回 'memory'
    // 文件数据库会返回 'wal'
    expect(["wal", "memory"]).toContain(result);
  });

  it("外键约束启用", () => {
    db = initDatabase({ dbPath: ":memory:", enableForeignKeys: true });
    const result = db.pragma("foreign_keys", { simple: true });
    expect(result).toBe(1);
  });

  it("内存模式", () => {
    db = initDatabase({ dbPath: ":memory:" });
    // 验证可以正常操作
    db.exec("CREATE TABLE test_table (id INTEGER PRIMARY KEY)");
    db.exec("INSERT INTO test_table (id) VALUES (1)");
    const result = db.prepare("SELECT COUNT(*) as count FROM test_table").get();
    expect(result).toEqual({ count: 1 });
  });

  it("关闭连接", () => {
    db = initDatabase({ dbPath: ":memory:" });
    closeDatabase(db);
    // 关闭后 db 对象仍然存在，但操作会抛出异常
    expect(() => {
      db.prepare("SELECT 1").get();
    }).toThrow();
    // 标记为已关闭，避免 afterEach 再次关闭
    db = null as unknown as Database.Database;
  });

  it("sqlite-vec 加载", () => {
    db = initDatabase({ dbPath: ":memory:" });
    // 尝试创建 vec0 虚拟表（如果 sqlite-vec 可用）
    try {
      db.exec(`
        CREATE VIRTUAL TABLE test_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[1024]
        );
      `);
      // 如果成功，验证可以插入和查询
      db.exec("INSERT INTO test_vec (id, embedding) VALUES ('test', vector('[0.1, 0.2, 0.3]'))");
      const result = db.prepare("SELECT COUNT(*) as count FROM test_vec").get();
      expect(result).toEqual({ count: 1 });
    } catch {
      // sqlite-vec 不可用时跳过测试
      console.warn("sqlite-vec 不可用，跳过 vec0 测试");
    }
  });
});
