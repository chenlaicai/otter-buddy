// lint-tests:allow-ddl —— 存量库回归用例需建 前旧形状 healing_events 表（与 migration.test.ts 同类：被测对象就是旧 schema → 新 schema 的补列/索引迁移本身，生产 schema 建不出旧表形态）
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { load as loadSqliteVec } from "sqlite-vec";
import { hashEntryProjectionContent } from "@usecases/memory/entry-projection-policy";

/** 创建内存 SQLite 数据库（不初始化 schema，用于测试 initSchema 本身） */
function createRawDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

/** 之前的 healing_events 旧表形状（无 bound_issue/bound_at，14 列）。
 *  形状对照源：git show b810c133^ 的建表块（检视獭-1390 逐列核对确认）。 */
function createPre1365HealingEventsTable(db: Database.Database): void {
  db.exec(
    [
      "CREATE TABLE healing_events (",
      "  id TEXT PRIMARY KEY,",
      "  message_id TEXT NOT NULL,",
      "  conversation_id TEXT NOT NULL,",
      "  otter_id TEXT NOT NULL,",
      "  error_type TEXT NOT NULL,",
      "  severity TEXT NOT NULL,",
      "  description TEXT NOT NULL,",
      "  suggestion TEXT NOT NULL DEFAULT '',",
      "  context TEXT,",
      "  status TEXT NOT NULL DEFAULT 'open',",
      "  resolution TEXT,",
      "  created_at TEXT NOT NULL DEFAULT (datetime('now')),",
      "  resolved_at TEXT,",
      "  introduced_by_pr TEXT",
      ");",
    ].join("\n"),
  );
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
    // 批4c：messages 族表已删除
    expect(tableNames).not.toContain("messages");
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

  it("外键约束生效：entry 引用不存在的 conversation_id 时抛出异常", () => {
    initSchema(db);

    db.prepare(`
      INSERT INTO conversations (id, title, created_at, updated_at)
      VALUES ('conv-1', 'test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `).run();

    // 引用不存在的 conversation_id
    expect(() => {
      db.prepare(`
        INSERT INTO entries (id, conversation_id, sequence_num, entry_type, sender_type, sender_id, created_at)
        VALUES ('entry-1', 'nonexistent-conv', 1, 'user', 'user', 'user-1', '2026-01-01T00:00:00Z')
      `).run();
    }).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("外键约束生效：entry 引用不存在的 invoke_id 时抛出异常", () => {
    initSchema(db);

    db.prepare(`
      INSERT INTO conversations (id, title, created_at, updated_at)
      VALUES ('conv-1', 'test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `).run();

    // 引用不存在的 invoke_id
    expect(() => {
      db.prepare(`
        INSERT INTO entries (id, conversation_id, sequence_num, entry_type, sender_type, sender_id, invoke_id, created_at)
        VALUES ('entry-1', 'conv-1', 1, 'speak', 'otter', 'otter-1', 'nonexistent-invoke', '2026-01-01T00:00:00Z')
      `).run();
    }).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("存量库回归（#1365 前 healing_events 无 bound_issue/bound_at）：initSchema 不炸且补齐列与索引", () => {
    // CREATE TABLE IF NOT EXISTS 对存量库是 no-op，若 bound_issue 索引抢在 ALTER 补列前
    // 创建会抛 no such column（事故根因）
    // 手写 DDL 靠本文件首行 lint-tests:allow-ddl 豁免放行——lint 正则剥注释后命中字符串
    // 字面量，拼接写法并不绕开检测；存量库建旧表与 attachments-kind-migration 同例
    createPre1365HealingEventsTable(db);

    expect(() => initSchema(db)).not.toThrow();

    const cols = db.prepare("PRAGMA table_info(healing_events)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("bound_issue");
    expect(cols.map((c) => c.name)).toContain("bound_at");

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'healing_events'",
    ).all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain("idx_healing_events_bound_issue");
  });

  it("半迁移形态回归（bound_issue 已补、bound_at 缺失）：initSchema 补齐剩余列与索引", () => {
    // -不变量锁：补列必须每列独立 try/catch——若回退成单块 try/catch，
    // 第一列已存在抛错时第二列（bound_at）的 ALTER 被整体吞掉、永远补不上。
    // 存量库回归用例抓不住这个回退（它两列都缺，第一列 ALTER 不抛错），必须单测半迁移形态
    createPre1365HealingEventsTable(db);
    db.exec(`ALTER TABLE healing_events ADD COLUMN bound_issue INTEGER`);

    expect(() => initSchema(db)).not.toThrow();

    const cols = db.prepare("PRAGMA table_info(healing_events)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("bound_at");

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'healing_events'",
    ).all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain("idx_healing_events_bound_issue");
  });
  it("memory 代际加法迁移回填 entry、任务与既有向量并保留 vec0 功能", () => {
    loadSqliteVec(db);
    db.exec(`
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        layer TEXT NOT NULL,
        content_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_table TEXT NOT NULL,
        conversation_id TEXT,
        granularity TEXT NOT NULL DEFAULT 'fine',
        content TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE VIRTUAL TABLE memory_vec USING vec0(
        memory_entry_id TEXT PRIMARY KEY,
        embedding FLOAT[1024]
      );
      CREATE TABLE embedding_tasks (
        entry_id TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_attempt_at TEXT,
        next_retry_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dead')),
        created_at TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 1
      );
    `);
    db.prepare(`
      INSERT INTO memory_entries (id, layer, content_type, source_id, source_table, content, created_at)
      VALUES ('legacy', 'working', 'message', 'legacy', 'entries', 'legacy content', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO embedding_tasks (entry_id, attempts, next_retry_at, status, created_at, last_error)
      VALUES ('legacy', 2, datetime('now'), 'pending', datetime('now'), 'keep attempts')
    `).run();
    const original = new Float32Array(1024).fill(0.75);
    db.prepare("INSERT INTO memory_vec (memory_entry_id, embedding) VALUES ('legacy', ?)")
      .run(Buffer.from(original.buffer));

    expect(() => initSchema(db)).not.toThrow();
    expect(() => initSchema(db)).not.toThrow();

    const entry = db.prepare("SELECT generation, content_hash FROM memory_entries WHERE id = 'legacy'").get() as {
      generation: number;
      content_hash: string;
    };
    expect(entry).toEqual({ generation: 1, content_hash: hashEntryProjectionContent("legacy content") });
    expect(db.prepare("SELECT generation, content_hash, attempts, last_error FROM embedding_tasks WHERE entry_id = 'legacy'").get())
      .toEqual({ generation: 1, content_hash: entry.content_hash, attempts: 2, last_error: "keep attempts" });
    expect(db.prepare("SELECT generation, content_hash FROM memory_vec_generations WHERE entry_id = 'legacy'").get())
      .toEqual({ generation: 1, content_hash: entry.content_hash });
    const stored = db.prepare("SELECT embedding FROM memory_vec WHERE memory_entry_id = 'legacy'").get() as { embedding: Buffer };
    expect(Array.from(new Float32Array(stored.embedding.buffer, stored.embedding.byteOffset, 1024))).toEqual(Array.from(original));
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_vec'").get()).toMatchObject({
      sql: expect.stringContaining("vec0"),
    });
    const nearest = db.prepare("SELECT memory_entry_id FROM memory_vec WHERE embedding MATCH ? AND k = 1")
      .get(Buffer.from(original.buffer));
    expect(nearest).toEqual({ memory_entry_id: "legacy" });
  });

});
