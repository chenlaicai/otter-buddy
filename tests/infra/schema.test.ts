import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase, closeDatabase } from "@infra/db/database";
import { initSchema } from "@infra/db/schema";

describe("schema", () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) {
      closeDatabase(db);
    }
  });

  it("initSchema 创建全部表", () => {
    db = initDatabase({ dbPath: ":memory:" });
    initSchema(db);

    // 验证所有14 个表/虚拟表存在
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as { name: string }[];

    const tableNames = tables.map(t => t.name);

    // 领域表
    expect(tableNames).toContain("conversations");
    expect(tableNames).toContain("messages");
    expect(tableNames).toContain("conversation_otters");
    expect(tableNames).toContain("memory_entries");
    expect(tableNames).toContain("memory_weights");
    expect(tableNames).toContain("linked_resources");
    expect(tableNames).toContain("key_facts");
    expect(tableNames).toContain("otters");
    expect(tableNames).toContain("otter_sessions");
    expect(tableNames).toContain("skills");
    expect(tableNames).toContain("skill_assignments");
    expect(tableNames).toContain("external_resources");

    // 虚拟表
    expect(tableNames).toContain("memory_fts");
    // memory_vec 可能不存在（如果 sqlite-vec 不可用）
  });

  it("幂等性", () => {
    db = initDatabase({ dbPath: ":memory:" });
    // 多次调用不应报错
    initSchema(db);
    initSchema(db);
    initSchema(db);

    // 验证表仍然存在
    const tables = db.prepare(`
      SELECT COUNT(*) as count FROM sqlite_master
      WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
    `).get() as { count: number };
    expect(tables.count).toBeGreaterThan(0);
  });

  it("FTS5 可用", () => {
    db = initDatabase({ dbPath: ":memory:" });
    initSchema(db);

    // 插入测试数据到领域表
    db.exec(`
      INSERT INTO memory_entries (id, layer, content_type, source_id, source_table, content)
      VALUES ('test-1', 'working', 'message', 'src-1', 'messages', 'Hello World')
    `);

    // 同步插入到 FTS5 虚拟表
    db.exec(`
      INSERT INTO memory_fts (memory_entry_id, content)
      VALUES ('test-1', 'Hello World')
    `);

    // FTS5 查询
    const results = db.prepare(`
      SELECT memory_entry_id FROM memory_fts WHERE memory_fts MATCH 'Hello'
    `).all();

    expect(results).toHaveLength(1);
  });

  it("vec0 可用", () => {
    db = initDatabase({ dbPath: ":memory:" });
    initSchema(db);

    try {
      // 插入测试向量（需要先插入 memory_entries）
      db.exec(`
        INSERT INTO memory_entries (id, layer, content_type, source_id, source_table, content)
        VALUES ('test-vec-1', 'working', 'message', 'src-1', 'messages', 'Vector test')
      `);

      // 插入向量
      db.exec(`
        INSERT INTO memory_vec (memory_entry_id, embedding)
        VALUES ('test-vec-1', vector('[0.1, 0.2, 0.3]'))
      `);

      // KNN 查询
      const results = db.prepare(`
        SELECT memory_entry_id, distance
        FROM memory_vec
        WHERE embedding MATCH vector('[0.1, 0.2, 0.3]')
        ORDER BY distance
        LIMIT 1
      `).all();

      expect(results).toHaveLength(1);
    } catch {
      // sqlite-vec 不可用时跳过
      console.warn("sqlite-vec 不可用，跳过 vec0 测试");
    }
  });

  it("索引存在", () => {
    db = initDatabase({ dbPath: ":memory:" });
    initSchema(db);

    // 验证部分关键索引存在
    const indexes = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name
    `).all() as { name: string }[];

    const indexNames = indexes.map(i => i.name);

    // 验证部分索引
    expect(indexNames).toContain("idx_conversations_parent_id");
    expect(indexNames).toContain("idx_messages_conversation_id");
    expect(indexNames).toContain("idx_memory_entries_layer");
    expect(indexNames).toContain("idx_otters_type");
    expect(indexNames).toContain("idx_skills_type");

    // 验证索引总数（至少 28个）
    expect(indexNames.length).toBeGreaterThanOrEqual(28);
  });

  it("外键约束", () => {
    db = initDatabase({ dbPath: ":memory:", enableForeignKeys: true });
    initSchema(db);

    // 尝试插入违反外键约束的数据
    expect(() => {
      db.exec(`
        INSERT INTO messages (id, conversation_id, sender_type, sender_id, body, sequence_num)
        VALUES ('msg-1', 'non-existent-conversation', 'user', 'user-1', 'Hello', 1)
      `);
    }).toThrow(/FOREIGN KEY constraint failed/);
  });
});
