/**
 * F20260728htar 一次性补丁测试：
 * (a) messages_fts_stripped_rebuild：存量 FTS 重建为剥离投影（settings 幂等键）
 * (b) attachments_drop_column：messages 表 DROP COLUMN attachments（PRAGMA 探测幂等）
 * F20260803pncv：addPinnedColumn — conversations 表添加 pinned 列（PRAGMA 探测幂等）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import type { Logger } from "@usecases/ports/logger";

function mockLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => mockLogger(),
  };
}

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function seedMessage(db: Database.Database, id: string, body: string): void {
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 't', '2026-07-28T00:00:00Z', '2026-07-28T00:00:00Z')`).run();
  db.prepare(`INSERT INTO turns (id, conversation_id, turn_number, created_at) VALUES ('turn-1', 'conv-1', 1, '2026-07-28T00:00:00Z')`).run();
  db.prepare(`INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, body, sequence_num, turn_id, created_at)
    VALUES (?, 'conv-1', 'otter', 'otter-1', 'completed', ?, 1, 'turn-1', '2026-07-28T00:01:00Z')`).run(id, body);
}

describe("migrateDatabase - F20260728htar 补丁", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe("messages_fts_stripped_rebuild", () => {
    it("存量 FTS 原文重建为剥离投影，并写入幂等键", () => {
      const body = '前言\n```html-card title="旧卡"\n<div>噪声</div>\n```\n后记';
      seedMessage(db, "msg-1", body);
      /** 模拟触发器时代的存量：FTS 里是未剥离的原文 */
      db.prepare("INSERT INTO messages_fts (message_id, body) VALUES ('msg-1', ?)").run(body);

      migrateDatabase(db, mockLogger());

      const fts = db.prepare("SELECT body FROM messages_fts WHERE message_id = 'msg-1'").get() as { body: string };
      expect(fts.body).toBe("前言\n[html-card: 旧卡]\n后记");
      /** messages.body 原文不动 */
      const msg = db.prepare("SELECT body FROM messages WHERE id = 'msg-1'").get() as { body: string };
      expect(msg.body).toBe(body);
      /** 幂等键已写入 */
      const key = db.prepare("SELECT value FROM settings WHERE key = 'messages_fts_stripped_rebuild'").get() as { value: string };
      expect(key.value).toBe("done");
    });

    it("幂等：二次启动不重复 rebuild", () => {
      seedMessage(db, "msg-1", "普通消息");
      migrateDatabase(db, mockLogger());

      /** rebuild 后人为改一行，第二次迁移不应触碰（证明幂等跳过） */
      db.prepare("UPDATE messages_fts SET body = '手动标记' WHERE message_id = 'msg-1'").run();
      migrateDatabase(db, mockLogger());

      const fts = db.prepare("SELECT body FROM messages_fts WHERE message_id = 'msg-1'").get() as { body: string };
      expect(fts.body).toBe("手动标记");
    });

    it("body 为 null 的存量消息 rebuild 后 FTS 为空串", () => {
      db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 't', '2026-07-28T00:00:00Z', '2026-07-28T00:00:00Z')`).run();
      db.prepare(`INSERT INTO turns (id, conversation_id, turn_number, created_at) VALUES ('turn-1', 'conv-1', 1, '2026-07-28T00:00:00Z')`).run();
      db.prepare(`INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, body, sequence_num, turn_id, created_at)
        VALUES ('msg-null', 'conv-1', 'otter', 'otter-1', 'streaming', NULL, 1, 'turn-1', '2026-07-28T00:01:00Z')`).run();

      migrateDatabase(db, mockLogger());

      const fts = db.prepare("SELECT body FROM messages_fts WHERE message_id = 'msg-null'").get() as { body: string };
      expect(fts.body).toBe("");
    });
  });

  describe("attachments_drop_column", () => {
    it("旧库的 attachments 列被 DROP", () => {
      /** 模拟旧库：initSchema 建的表已无该列，手动加回 */
      db.prepare("ALTER TABLE messages ADD COLUMN attachments TEXT").run();

      migrateDatabase(db, mockLogger());

      const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      expect(columns.some(c => c.name === "attachments")).toBe(false);
    });

    it("列不存在时跳过（天然幂等），二次执行不报错", () => {
      migrateDatabase(db, mockLogger());
      expect(() => migrateDatabase(db, mockLogger())).not.toThrow();

      const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      expect(columns.some(c => c.name === "attachments")).toBe(false);
    });
  });

  describe("addPinnedColumn", () => {
    it("旧库升级：conversations 表无 pinned 列时，migrateDatabase 添加该列且默认值为 0", () => {
      /** 模拟旧库：initSchema 建的表已含 pinned，先 DROP 模拟升级前状态 */
      db.prepare("ALTER TABLE conversations DROP COLUMN pinned").run();

      const beforeColumns = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
      expect(beforeColumns.some(c => c.name === "pinned")).toBe(false);

      migrateDatabase(db, mockLogger());

      const afterColumns = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string; dflt_value: string | null; notnull: number }>;
      const pinnedCol = afterColumns.find(c => c.name === "pinned");
      expect(pinnedCol).toBeDefined();
      expect(pinnedCol!.dflt_value).toBe("0");
      expect(pinnedCol!.notnull).toBe(1);

      /** 验证默认值：插入一条记录，pinned 应为 0 */
      db.prepare("INSERT INTO conversations (id, title) VALUES ('conv-test', '测试')").run();
      const row = db.prepare("SELECT pinned FROM conversations WHERE id = 'conv-test'").get() as { pinned: number };
      expect(row.pinned).toBe(0);
    });

    it("幂等：已有 pinned 列的库，migrateDatabase 不报错", () => {
      /** initSchema 已创建 pinned 列，直接 migrate 不应抛错 */
      expect(() => migrateDatabase(db, mockLogger())).not.toThrow();

      const columns = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
      expect(columns.some(c => c.name === "pinned")).toBe(true);
    });
  });
});

/**
 * F20260803mval 补丁测试：rebuildDocumentTablesDropCheck
 * 重建 features/research 表移除枚举 CHECK 约束（SQLite 不支持 DROP CHECK，必须重建表）
 */
describe("migrateDatabase - F20260803mval 补丁: rebuildDocumentTablesDropCheck", () => {
  /** 模拟旧库：features 表带枚举 CHECK 约束 */
  function createOldSchemaDb(): Database.Database {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    // initSchema 建的 features 已无 CHECK，DROP 后用旧式定义重建（模拟升级前旧库）
    db.exec("DROP TABLE features");
    db.exec(`
      CREATE TABLE features (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 500),
        change_type TEXT NOT NULL CHECK(change_type IN ('feature', 'refactor', 'fix')),
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'development', 'locked', 'archived')),
        tags TEXT NOT NULL DEFAULT '[]',
        modules TEXT NOT NULL DEFAULT '[]',
        causal_links_from TEXT NOT NULL DEFAULT '[]',
        supersedes TEXT NOT NULL DEFAULT '[]',
        file_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK(id LIKE 'F%')
      );
    `);
    db.prepare(
      "INSERT INTO features (id, title, summary, change_type, status, file_path) VALUES (?, ?, ?, 'feature', 'draft', ?)"
    ).run("F20260803ol1", "旧文档", "旧摘要内容", "docs/features/old.md");
    return db;
  }

  it("移除 CHECK 约束，新枚举值（prompt/final）可入库，旧数据完整保留", () => {
    const db = createOldSchemaDb();
    try {
      migrateDatabase(db, mockLogger());

      // CHECK 移除：旧约束拒收的值现在可入
      expect(() =>
        db.prepare(
          "INSERT INTO features (id, title, summary, change_type, status, file_path) VALUES (?, ?, ?, 'prompt', 'final', ?)"
        ).run("F20260803prm1", "提示词文档", "摘要", "docs/features/p.md")
      ).not.toThrow();

      // 旧数据完整迁移
      const row = db.prepare("SELECT title, summary FROM features WHERE id = 'F20260803ol1'").get() as { title: string; summary: string };
      expect(row.title).toBe("旧文档");
      expect(row.summary).toBe("旧摘要内容");

      // 幂等键
      const key = db.prepare("SELECT value FROM settings WHERE key = 'doc_check_constraints_dropped'").get() as { value: string };
      expect(key.value).toBe("done");
    } finally {
      db.close();
    }
  });

  it("幂等：二次迁移不报错不重复重建", () => {
    const db = createOldSchemaDb();
    try {
      migrateDatabase(db, mockLogger());
      expect(() => migrateDatabase(db, mockLogger())).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("全新库（initSchema 建的无 CHECK 表）：直接 markDone 不重建", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db); // 新 schema 无 CHECK
      migrateDatabase(db, mockLogger());
      const key = db.prepare("SELECT value FROM settings WHERE key = 'doc_check_constraints_dropped'").get() as { value: string };
      expect(key.value).toBe("done");
    } finally {
      db.close();
    }
  });
});
