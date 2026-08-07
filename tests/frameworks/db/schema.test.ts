import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";

/** 创建内存 SQLite 数据库（不初始化 schema，用于测试 initSchema 本身） */
function createRawDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

/** 获取数据库中所有用户表名称（排除 sqlite 内部表） */
function getTableNames(db: Database.Database): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe("initSchema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createRawDb();
  });

  afterEach(() => {
    db.close();
  });

  it("幂等性：重复调用不抛出异常", () => {
    initSchema(db);

    // 第二次调用不应抛出异常
    expect(() => initSchema(db)).not.toThrow();

    // 第三次调用也不应抛出异常
    expect(() => initSchema(db)).not.toThrow();

    // 表数量与首次一致
    const tableNames = getTableNames(db);
    expect(tableNames).toContain("conversations");
    expect(tableNames).toContain("messages");
  });

  it("CHECK 约束生效：features 表 id 必须以 F 开头", () => {
    initSchema(db);

    // 以 R 开头的 id 应被 CHECK 约束拒绝
    expect(() => {
      db.prepare(`
        INSERT INTO features (id, title, summary, change_type, file_path, created_at)
        VALUES ('R001', 'test', 'test summary', 'feature', '/path/to/file', '2026-01-01T00:00:00Z')
      `).run();
    }).toThrow();
  });

  it("CHECK 约束生效：research 表 id 必须以 R 开头", () => {
    initSchema(db);

    // 以 F 开头的 id 应被 CHECK 约束拒绝
    expect(() => {
      db.prepare(`
        INSERT INTO research (id, title, summary, exploration_type, file_path, created_at)
        VALUES ('F001', 'test', 'test summary', 'technical', '/path/to/file', '2026-01-01T00:00:00Z')
      `).run();
    }).toThrow();
  });

  it("CHECK 约束生效：scheduled_tasks 表 body 长度不超过 10000", () => {
    initSchema(db);

    // 先插入一个对话（外键依赖）
    db.prepare(`
      INSERT INTO conversations (id, title, created_at, updated_at)
      VALUES ('conv-1', 'test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `).run();

    const longBody = "a".repeat(10001);
    expect(() => {
      db.prepare(`
        INSERT INTO scheduled_tasks (id, conversation_id, name, cron, body, sender_id, created_at, updated_at)
        VALUES ('task-1', 'conv-1', 'test', '* * * * *', ?, 'sender-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      `).run(longBody);
    }).toThrow();
  });

  it("外键约束生效：message 引用不存在的 conversation_id 时抛出异常", () => {
    initSchema(db);

    // 先插入一个对话和 turn（messages 依赖 conversations 和 turns）
    db.prepare(`
      INSERT INTO conversations (id, title, created_at, updated_at)
      VALUES ('conv-1', 'test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `).run();

    db.prepare(`
      INSERT INTO turns (id, conversation_id, turn_number, created_at)
      VALUES ('turn-1', 'conv-1', 1, '2026-01-01T00:00:00Z')
    `).run();

    // 引用不存在的 conversation_id
    expect(() => {
      db.prepare(`
        INSERT INTO messages (id, conversation_id, sender_type, sender_id, sequence_num, turn_id, created_at)
        VALUES ('msg-1', 'nonexistent-conv', 'user', 'user-1', 1, 'turn-1', '2026-01-01T00:00:00Z')
      `).run();
    }).toThrow();
  });

  it("外键约束生效：message 引用不存在的 turn_id 时抛出异常", () => {
    initSchema(db);

    db.prepare(`
      INSERT INTO conversations (id, title, created_at, updated_at)
      VALUES ('conv-1', 'test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `).run();

    // 引用不存在的 turn_id
    expect(() => {
      db.prepare(`
        INSERT INTO messages (id, conversation_id, sender_type, sender_id, sequence_num, turn_id, created_at)
        VALUES ('msg-1', 'conv-1', 'user', 'user-1', 1, 'nonexistent-turn', '2026-01-01T00:00:00Z')
      `).run();
    }).toThrow();
  });
});
