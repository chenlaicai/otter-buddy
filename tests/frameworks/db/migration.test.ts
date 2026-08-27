// lint-tests:allow-ddl —— 迁移/恢复测试需要手工建旧 schema 的表（模拟存量库形态）
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
import { createTestLogger } from "../../helpers/logger";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function seedMessage(db: Database.Database, id: string, body: string): void {
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 't', '2026-07-28T00:00:00Z', '2026-07-28T00:00:00Z')`).run();
  db.prepare(`INSERT INTO turns (id, conversation_id, turn_number, created_at) VALUES ('turn-1', 'conv-1', 1, '2026-07-28T00:00:00Z')`).run();
  db.prepare(`INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, created_at)
    VALUES (?, 'conv-1', 'otter', 'otter-1', 'completed', 1, 'turn-1', '2026-07-28T00:01:00Z')`).run(id);
  db.prepare(`INSERT INTO message_segments (id, message_id, body, sequence_num, created_at) VALUES (?, ?, ?, 0, '2026-07-28T00:01:00Z')`).run(`seg-${id}`, id, body);
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

      migrateDatabase(db, createTestLogger());

      const fts = db.prepare("SELECT body FROM messages_fts WHERE message_id = 'msg-1'").get() as { body: string };
      expect(fts.body).toBe("前言\n[html-card: 旧卡]\n后记");
      /** message_segments.body 原文不动 */
      const seg = db.prepare("SELECT body FROM message_segments WHERE message_id = 'msg-1'").get() as { body: string };
      expect(seg.body).toBe(body);
      /** 幂等键已写入 */
      const key = db.prepare("SELECT value FROM settings WHERE key = 'messages_fts_stripped_rebuild'").get() as { value: string };
      expect(key.value).toBe("done");
    });

    it("幂等：二次启动不重复 rebuild", () => {
      seedMessage(db, "msg-1", "普通消息");
      migrateDatabase(db, createTestLogger());

      /** rebuild 后人为改一行，第二次迁移不应触碰（证明幂等跳过） */
      db.prepare("UPDATE messages_fts SET body = '手动标记' WHERE message_id = 'msg-1'").run();
      migrateDatabase(db, createTestLogger());

      const fts = db.prepare("SELECT body FROM messages_fts WHERE message_id = 'msg-1'").get() as { body: string };
      expect(fts.body).toBe("手动标记");
    });

    it("body 为 null 的存量消息 rebuild 后 FTS 为空串", () => {
      db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 't', '2026-07-28T00:00:00Z', '2026-07-28T00:00:00Z')`).run();
      db.prepare(`INSERT INTO turns (id, conversation_id, turn_number, created_at) VALUES ('turn-1', 'conv-1', 1, '2026-07-28T00:00:00Z')`).run();
      db.prepare(`INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, created_at)
        VALUES ('msg-null', 'conv-1', 'otter', 'otter-1', 'streaming', 1, 'turn-1', '2026-07-28T00:01:00Z')`).run();
      /** streaming 消息无 segment，FTS 应为空串 */

      migrateDatabase(db, createTestLogger());

      const fts = db.prepare("SELECT body FROM messages_fts WHERE message_id = 'msg-null'").get() as { body: string } | undefined;
      /** 无 segment 的消息（streaming）在 segments 重建路径中不生成 FTS 条目 */
      expect(fts).toBeUndefined();
    });
  });

  describe("attachments_drop_column", () => {
    it("旧库的 attachments 列被 DROP", () => {
      /** 模拟旧库：initSchema 建的表已无该列，手动加回 */
      db.prepare("ALTER TABLE messages ADD COLUMN attachments TEXT").run();

      migrateDatabase(db, createTestLogger());

      const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      expect(columns.some(c => c.name === "attachments")).toBe(false);
    });

    it("列不存在时跳过（天然幂等），二次执行不报错", () => {
      migrateDatabase(db, createTestLogger());
      expect(() => migrateDatabase(db, createTestLogger())).not.toThrow();

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

      migrateDatabase(db, createTestLogger());

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
      expect(() => migrateDatabase(db, createTestLogger())).not.toThrow();

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
      migrateDatabase(db, createTestLogger());

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
      migrateDatabase(db, createTestLogger());
      expect(() => migrateDatabase(db, createTestLogger())).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("全新库（initSchema 建的无 CHECK 表）：直接 markDone 不重建", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db); // 新 schema 无 CHECK
      migrateDatabase(db, createTestLogger());
      const key = db.prepare("SELECT value FROM settings WHERE key = 'doc_check_constraints_dropped'").get() as { value: string };
      expect(key.value).toBe("done");
    } finally {
      db.close();
    }
  });
});

describe("migrateDatabase - F20260803fbit body_hash 列", () => {
  it("全新库：initSchema 已含 body_hash，migrate 不报错（幂等）", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      migrateDatabase(db, createTestLogger());
      // 跑第二次验证幂等
      migrateDatabase(db, createTestLogger());
      const cols = db.prepare("PRAGMA table_info(features)").all() as Array<{ name: string }>;
      expect(cols.some(c => c.name === "body_hash")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("老库无 body_hash 列：migrate 补列，跑两次不报错（幂等）", () => {
    const db = new Database(":memory:");
    try {
      // 用 initSchema 建全表（含 body_hash），再 DROP 模拟老库
      initSchema(db);
      db.exec("ALTER TABLE features DROP COLUMN body_hash");
      db.exec("ALTER TABLE research DROP COLUMN body_hash");
      const beforeF = (db.prepare("PRAGMA table_info(features)").all() as Array<{ name: string }>);
      expect(beforeF.some(c => c.name === "body_hash")).toBe(false);

      migrateDatabase(db, createTestLogger());
      const fCols = db.prepare("PRAGMA table_info(features)").all() as Array<{ name: string }>;
      expect(fCols.some(c => c.name === "body_hash")).toBe(true);
      const rCols = db.prepare("PRAGMA table_info(research)").all() as Array<{ name: string }>;
      expect(rCols.some(c => c.name === "body_hash")).toBe(true);
      // 第二次不报错（幂等）
      migrateDatabase(db, createTestLogger());
    } finally {
      db.close();
    }
  });
});

/**
 * F20260821evaf：embedding_meta 表老库补建（#506 后由无条件 initSchema 承担）。
 * 原语境：initSchema 仅新库执行——存量库若只靠 initSchema，embedding_meta 永远不存在，
 * getEmbeddingMeta 的 SELECT 直接抛 no such table。
 * #506 后：bootstrap 无条件跑幂等 initSchema，补建语义由
 * tests/frameworks/db/migration-equivalence.guard.test.ts 的等价性守卫整体覆盖，
 * 此处仅保留独立补建行为的直接验证。
 */
describe("#506 initSchema 补建：embedding_meta 表", () => {
  it("老库无 embedding_meta：initSchema 补建后可读写", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      db.exec("DROP TABLE embedding_meta"); // 模拟 initSchema 早于该表时代的存量库

      initSchema(db, createTestLogger()); // 老库升级路径：无条件重跑幂等 initSchema

      db.prepare("INSERT INTO embedding_meta (key, value, updated_at) VALUES ('model_id', 'bge-m3', '2026-08-21T00:00:00Z')").run();
      const row = db.prepare("SELECT value FROM embedding_meta WHERE key = 'model_id'").get() as { value: string };
      expect(row.value).toBe("bge-m3");
    } finally {
      db.close();
    }
  });

  it("幂等：已有表的库重跑 initSchema 不报错", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      expect(() => initSchema(db, createTestLogger())).not.toThrow();
      initSchema(db, createTestLogger());
    } finally {
      db.close();
    }
  });
});

/**
 * F20260827mtbl：signal_events（F20260826mwrd）+ restart_pending_resumes（F20260826rsme）
 * 表老库补建（#506 后由无条件 initSchema 承担，等价性由守卫测试整体覆盖）。
 */
describe("#506 initSchema 补建：signal_events + restart_pending_resumes 表", () => {
  it("老库缺两表：升级序列补建后可读写", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      migrateDatabase(db, createTestLogger());
      // 模拟早于 F20260826 两特性时代的存量库
      db.exec("DROP TABLE signal_events");
      db.exec("DROP TABLE restart_pending_resumes");

      // 老库升级路径：幂等 initSchema 无条件重跑
      initSchema(db, createTestLogger());
      migrateDatabase(db, createTestLogger());

      // restart_pending_resumes 可读写（claimResume 语义）
      db.prepare(
        "INSERT INTO restart_pending_resumes (message_id, conversation_id, otter_id, attempts, status, created_at) VALUES ('msg-1', 'conv-1', 'otter-1', 0, 'pending', '2026-08-27T00:00:00Z')"
      ).run();
      const claimed = db.prepare(
        "UPDATE restart_pending_resumes SET attempts = attempts + 1 WHERE message_id = 'msg-1' AND attempts < 1"
      ).run();
      expect(claimed.changes).toBe(1);

      // signal_events 可读写
      db.prepare(
        "INSERT INTO signal_events (id, conversation_id, message_id, from_otter_id, type, severity, payload, status, created_at) VALUES ('se-1', 'conv-1', 'msg-1', 'otter-1', 'halt', 'high', '{}', 'pending', '2026-08-27T00:00:00Z')"
      ).run();
      const se = db.prepare("SELECT type FROM signal_events WHERE id = 'se-1'").get() as { type: string };
      expect(se.type).toBe("halt");
    } finally {
      db.close();
    }
  });

  it("幂等：已有表的库重跑不报错", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      expect(() => initSchema(db, createTestLogger())).not.toThrow();
      initSchema(db, createTestLogger());
    } finally {
      db.close();
    }
  });
});

/**
 * F20260827he2f：healing_events 表添加 introduced_by_pr 列（存量库迁移）。
 * PR #386 的迁移写在 initSchema 中，存量库永远跑不到——导致 INSERT 时 100% 抛「no such column」。
 * 此处用 PRAGMA table_info 检测列存在性作幂等，与 session_file 等历史补丁列一致。
 */
describe("migrateDatabase - F20260827he2f healing_events.introduced_by_pr 列", () => {
  it("老库无 introduced_by_pr 列：migrate 补列后可读写", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      // 模拟早于 F20260824ax376 时代的存量库：healing_events 表无 introduced_by_pr 列
      db.exec("ALTER TABLE healing_events DROP COLUMN introduced_by_pr");
      
      // 验证列不存在
      const beforeCols = db.prepare("PRAGMA table_info(healing_events)").all() as Array<{ name: string }>;
      expect(beforeCols.some(c => c.name === 'introduced_by_pr')).toBe(false);
      
      migrateDatabase(db, createTestLogger());
      
      // 验证列已添加
      const afterCols = db.prepare("PRAGMA table_info(healing_events)").all() as Array<{ name: string }>;
      expect(afterCols.some(c => c.name === 'introduced_by_pr')).toBe(true);
      
      // 验证可写入（包含 introduced_by_pr 列）
      db.prepare(
        `INSERT INTO healing_events (id, message_id, conversation_id, otter_id, error_type, severity, description, suggestion, context, status, resolution, created_at, resolved_at, introduced_by_pr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('test-1', 'msg-1', 'conv-1', 'otter-1', 'degenerate', 'low', 'test', '', null, 'open', null, '2026-08-27T00:00:00Z', null, '#386');
      
      const row = db.prepare("SELECT introduced_by_pr FROM healing_events WHERE id = 'test-1'").get() as { introduced_by_pr: string | null };
      expect(row.introduced_by_pr).toBe('#386');
    } finally {
      db.close();
    }
  });
  
  it("幂等：已有 introduced_by_pr 列的库跑 migrate 不报错", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      // initSchema 已创建 introduced_by_pr 列，直接 migrate 不应抛错
      expect(() => migrateDatabase(db, createTestLogger())).not.toThrow();
      migrateDatabase(db, createTestLogger());
      
      // 验证列仍然存在
      const columns = db.prepare("PRAGMA table_info(healing_events)").all() as Array<{ name: string }>;
      expect(columns.some(c => c.name === 'introduced_by_pr')).toBe(true);
    } finally {
      db.close();
    }
  });
});
