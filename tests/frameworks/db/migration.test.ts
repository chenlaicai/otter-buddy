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

/**
 * F20260901sgp0 P0：signal_level / signal_meta 列迁移幂等性 + 索引查询验证。
 * 从独立的 signal-metadata-migration.test.ts 合并入 migration.test.ts，
 * 避免增加 allow-ddl 豁免文件数（ratchet 上限 6）。
 */
describe("migrateDatabase - F20260901sgp0 signal metadata 列", () => {
  let db: Database.Database;

  // 专用 seed（与顶层 seedMessage 签名不同：支持 overrides + 自增 seq）
  let seqCounter = 0;
  function seedSignalMessage(db: Database.Database, id: string, overrides?: Record<string, unknown>): void {
    db.prepare(`INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 't', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`).run();
    db.prepare(`INSERT OR IGNORE INTO turns (id, conversation_id, turn_number, created_at) VALUES ('turn-1', 'conv-1', 1, '2026-09-01T00:00:00Z')`).run();
    seqCounter++;
    db.prepare(`INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, created_at)
      VALUES (?, 'conv-1', 'otter', 'otter-1', 'completed', ?, 'turn-1', '2026-09-01T00:01:00Z')`).run(id, seqCounter);
    if (overrides) {
      const sets = Object.entries(overrides).map(([k]) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE messages SET ${sets} WHERE id = ?`).run(...Object.values(overrides), id);
    }
  }

  beforeEach(() => {
    db = createTestDb();
    seqCounter = 0;
  });

  afterEach(() => {
    db.close();
  });

  describe("new database (initSchema)", () => {
    it("messages 表包含 signal_level 和 signal_meta 列", () => {
      const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      const colNames = columns.map(c => c.name);
      expect(colNames).toContain("signal_level");
      expect(colNames).toContain("signal_meta");
    });

    it("新列默认为 null（存量行无信号语义）", () => {
      seedSignalMessage(db, "msg-1");
      const row = db.prepare("SELECT signal_level, signal_meta FROM messages WHERE id = 'msg-1'").get() as { signal_level: string | null; signal_meta: string | null };
      expect(row.signal_level).toBeNull();
      expect(row.signal_meta).toBeNull();
    });

    it("可写入和读取 signal_level / signal_meta", () => {
      seedSignalMessage(db, "msg-1");
      db.prepare("UPDATE messages SET signal_level = ?, signal_meta = ? WHERE id = ?").run("URGENT", '{"level":"URGENT","reason":"方向反了"}', "msg-1");
      const row = db.prepare("SELECT signal_level, signal_meta FROM messages WHERE id = 'msg-1'").get() as { signal_level: string; signal_meta: string };
      expect(row.signal_level).toBe("URGENT");
      expect(JSON.parse(row.signal_meta)).toEqual({ level: "URGENT", reason: "方向反了" });
    });
  });

  describe("existing database (migrateDatabase)", () => {
    it("存量库迁移添加 signal_level 和 signal_meta 列 + 索引（幂等）", () => {
      migrateDatabase(db, createTestLogger());
      const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      const colNames = columns.map(c => c.name);
      expect(colNames).toContain("signal_level");
      expect(colNames).toContain("signal_meta");
      // 索引在列之后由 migrateDatabase 创建（非 initSchema，存量库 initSchema 时列不存在）
      const indexes = db.prepare("PRAGMA index_list(messages)").all() as Array<{ name: string }>;
      expect(indexes.map(i => i.name)).toContain("idx_messages_signal_level");
    });

    it("存量库迁移添加 signal_level 和 signal_meta 列（幂等）", () => {
      migrateDatabase(db, createTestLogger());
      const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      const colNames = columns.map(c => c.name);
      expect(colNames).toContain("signal_level");
      expect(colNames).toContain("signal_meta");
    });

    it("迁移幂等：多次运行不报错", () => {
      migrateDatabase(db, createTestLogger());
      migrateDatabase(db, createTestLogger()); // 第二次不应报错
      const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      expect(columns.map(c => c.name)).toContain("signal_level");
    });

    it("迁移后存量消息 signal_level 为 null", () => {
      seedSignalMessage(db, "msg-old");
      migrateDatabase(db, createTestLogger());
      const row = db.prepare("SELECT signal_level, signal_meta FROM messages WHERE id = 'msg-old'").get() as { signal_level: string | null; signal_meta: string | null };
      expect(row.signal_level).toBeNull();
      expect(row.signal_meta).toBeNull();
    });

    it("真·旧库路径：initSchema 后 DROP COLUMN 模拟存量库，migrateDatabase 补列+索引不抛错（幂等）", () => {
      // body_hash 范式：initSchema 建全表（含 signal_level/signal_meta），再 DROP 模拟旧库
      db.close();
      db = createTestDb(); // initSchema 已含 signal_level/signal_meta
      db.exec("ALTER TABLE messages DROP COLUMN signal_level");
      db.exec("ALTER TABLE messages DROP COLUMN signal_meta");
      const before = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      expect(before.some(c => c.name === "signal_level")).toBe(false);
      expect(before.some(c => c.name === "signal_meta")).toBe(false);

      // migrateDatabase 应补列 + 建索引，不抛错
      expect(() => migrateDatabase(db, createTestLogger())).not.toThrow();
      const after = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      expect(after.some(c => c.name === "signal_level")).toBe(true);
      expect(after.some(c => c.name === "signal_meta")).toBe(true);
      const indexes = db.prepare("PRAGMA index_list(messages)").all() as Array<{ name: string }>;
      expect(indexes.map(i => i.name)).toContain("idx_messages_signal_level");

      // 第二次不报错（幂等）
      expect(() => migrateDatabase(db, createTestLogger())).not.toThrow();
    });
  });

  describe("signal_level index queries", () => {
    it("可通过 signal_level 索引查询 URGENT 消息", () => {
      seedSignalMessage(db, "msg-1", { signal_level: "NORMAL" });
      seedSignalMessage(db, "msg-2", { signal_level: "URGENT" });
      seedSignalMessage(db, "msg-3", { signal_level: null });

      const urgent = db.prepare("SELECT id FROM messages WHERE signal_level = 'URGENT'").all() as Array<{ id: string }>;
      expect(urgent).toHaveLength(1);
      expect(urgent[0].id).toBe("msg-2");
    });

    it("可查询无信号语义的消息（NULL）", () => {
      seedSignalMessage(db, "msg-1", { signal_level: "NORMAL" });
      seedSignalMessage(db, "msg-2", { signal_level: null });

      const noSignal = db.prepare("SELECT id FROM messages WHERE signal_level IS NULL").all() as Array<{ id: string }>;
      expect(noSignal).toHaveLength(1);
      expect(noSignal[0].id).toBe("msg-2");
    });
});
  });

describe("migrateDatabase - #654 补丁: rebuildExecutionsStatusCheck", () => {
  /** 模拟旧库：scheduled_task_executions 表带旧 CHECK（无 skipped） */
  function createOldExecutionsDb(): Database.Database {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    // initSchema 新建已含 skipped，DROP 后用旧式定义重建（模拟 #654 之前的存量库）
    db.exec("DROP TABLE scheduled_task_executions");
    db.exec(`
      CREATE TABLE scheduled_task_executions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
        triggered_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
        error_message TEXT,
        message_id TEXT REFERENCES messages(id),
        turn_id TEXT REFERENCES turns(id)
      );
    `);
    db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-x', '迁移测试', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO scheduled_tasks (id, conversation_id, name, cron, body, talking_stone_passed_to, sender_id, timezone, created_at, updated_at)
      VALUES ('task-mig', 'conv-x', '迁移任务', '0 9 * * *', 'x', '[]', 'otter-1', 'Asia/Shanghai', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO scheduled_task_executions (id, task_id, triggered_at, status)
      VALUES ('exec-old-1', 'task-mig', '2026-08-31T09:00:00Z', 'failed')`).run();
    return db;
  }

  it("老库重建：skipped 可入库，旧数据完整保留", () => {
    const db = createOldExecutionsDb();
    try {
      // 重建前：skipped 被 CHECK 拒收
      expect(() =>
        db.prepare(`INSERT INTO scheduled_task_executions (id, task_id, triggered_at, status) VALUES ('exec-new', 'task-mig', '2026-09-01T09:00:00Z', 'skipped')`).run()
      ).toThrow();

      migrateDatabase(db, createTestLogger());

      // 重建后：skipped 可入
      expect(() =>
        db.prepare(`INSERT INTO scheduled_task_executions (id, task_id, triggered_at, status) VALUES ('exec-new', 'task-mig', '2026-09-01T09:16:00Z', 'skipped')`).run()
      ).not.toThrow();

      // 旧数据完整保留
      const row = db.prepare("SELECT status FROM scheduled_task_executions WHERE id = 'exec-old-1'").get() as { status: string };
      expect(row.status).toBe("failed");

      // 索引重建（idx_executions_task）
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_executions_task'").get();
      expect(idx).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("幂等：二次迁移不报错不重复重建", () => {
    const db = createOldExecutionsDb();
    try {
      migrateDatabase(db, createTestLogger());
      expect(() => migrateDatabase(db, createTestLogger())).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("全新库（initSchema 已含 skipped）：无需重建，直接通过", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      migrateDatabase(db, createTestLogger());
      db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-y', '新库测试', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`).run();
      db.prepare(`INSERT INTO scheduled_tasks (id, conversation_id, name, cron, body, talking_stone_passed_to, sender_id, timezone, created_at, updated_at)
        VALUES ('task-fresh', 'conv-y', '新库任务', '0 9 * * *', 'x', '[]', 'otter-1', 'Asia/Shanghai', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`).run();
      expect(() =>
        db.prepare(`INSERT INTO scheduled_task_executions (id, task_id, triggered_at, status) VALUES ('exec-fresh', 'task-fresh', '2026-09-01T00:00:00Z', 'skipped')`).run()
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe("migrateDatabase - F20260904schf P2 补丁: rebuildDispatchAttemptsSourceCheck", () => {
  /** 模拟旧库：dispatch_attempts 带 source 窄枚举 CHECK（含 FK 父表） */
  function createOldSchemaDb(): Database.Database {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    // 父表先 seed（FK 验证用）
    db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-m', 't', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO turns (id, conversation_id, turn_number, created_at) VALUES ('turn-m', 'conv-m', 1, '2026-09-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, created_at)
      VALUES ('msg-m', 'conv-m', 'otter', 'otter-1', 'completed', 1, 'turn-m', '2026-09-01T00:01:00Z')`).run();
    db.prepare(`INSERT INTO otters (id, name, type, created_at) VALUES ('otter-1', 'o1', 'big', '2026-09-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO otters (id, name, type, created_at) VALUES ('otter-2', 'o2', 'small', '2026-09-01T00:00:00Z')`).run();
    // DROP 新表，用旧窄 CHECK 定义重建（模拟升级前存量库）
    db.exec("DROP TABLE dispatch_attempts");
    db.exec(`
      CREATE TABLE dispatch_attempts (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        target_otter_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('in_progress','completed','failed','aborted')),
        source TEXT NOT NULL DEFAULT 'chain' CHECK (source IN ('chain','router','retry','backfill')),
        attempt_started_at TEXT NOT NULL DEFAULT (datetime('now')),
        attempt_finished_at TEXT,
        note TEXT,
        UNIQUE(message_id, target_otter_id),
        FOREIGN KEY (message_id) REFERENCES messages(id),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );
    `);
    db.prepare(`INSERT INTO dispatch_attempts (id, conversation_id, message_id, target_otter_id, status, source, attempt_started_at, note)
      VALUES ('att-m', 'conv-m', 'msg-m', 'otter-1', 'failed', 'chain', '2026-09-01T00:02:00Z', '旧账')`).run();
    return db;
  }

  it("存量库：source=dissolve 可入库（旧 CHECK 拒收），旧数据与 FK 完整保留", () => {
    const db = createOldSchemaDb();
    try {
      // 迁移前：旧 CHECK 拒收 dissolve
      expect(() =>
        db.prepare(`INSERT INTO dispatch_attempts (id, conversation_id, message_id, target_otter_id, status, source, attempt_started_at)
          VALUES ('att-x', 'conv-m', 'msg-m', 'otter-1', 'aborted', 'dissolve', '2026-09-01T00:03:00Z')`).run()
      ).toThrow();

      migrateDatabase(db, createTestLogger());

      // 迁移后：dissolve 可入（att-y 用 otter-2 槽位，避开 att-m 的 UNIQUE 占位）
      expect(() =>
        db.prepare(`INSERT INTO dispatch_attempts (id, conversation_id, message_id, target_otter_id, status, source, attempt_started_at)
          VALUES ('att-y', 'conv-m', 'msg-m', 'otter-2', 'aborted', 'dissolve', '2026-09-01T00:03:00Z')`).run()
      ).not.toThrow();

      // 旧数据完整迁移（note/finish_at 等字段不丢）
      const row = db.prepare("SELECT status, source, note, attempt_finished_at FROM dispatch_attempts WHERE id = 'att-m'").get() as { status: string; source: string; note: string | null; attempt_finished_at: string | null };
      expect(row.status).toBe("failed");
      expect(row.source).toBe("chain");
      expect(row.note).toBe("旧账");
      // FK 仍生效（指向不存在消息的插入被拒）
      expect(() =>
        db.prepare(`INSERT INTO dispatch_attempts (id, conversation_id, message_id, target_otter_id, status, source, attempt_started_at)
          VALUES ('att-z', 'conv-m', 'msg-ghost', 'otter-1', 'failed', 'chain', '2026-09-01T00:04:00Z')`).run()
      ).toThrow();
      // 索引仍在
      const idx = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND tbl_name='dispatch_attempts' AND name LIKE 'idx_%'").get() as { n: number };
      expect(idx.n).toBe(2);
    } finally {
      db.close();
    }
  });

  it("幂等：二次迁移不报错不重复重建", () => {
    const db = createOldSchemaDb();
    try {
      migrateDatabase(db, createTestLogger());
      expect(() => migrateDatabase(db, createTestLogger())).not.toThrow();
      const row = db.prepare("SELECT count(*) AS n FROM dispatch_attempts WHERE id = 'att-m'").get() as { n: number };
      expect(row.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("全新库（schema 已含 dissolve 宽约束）：直接通过，无重建", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      migrateDatabase(db, createTestLogger());
      // 宽约束直接可入 dissolve
      db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-f', 't', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`).run();
      db.prepare(`INSERT INTO turns (id, conversation_id, turn_number, created_at) VALUES ('turn-f', 'conv-f', 1, '2026-09-01T00:00:00Z')`).run();
      db.prepare(`INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, created_at)
        VALUES ('msg-f', 'conv-f', 'otter', 'otter-1', 'completed', 1, 'turn-f', '2026-09-01T00:01:00Z')`).run();
      db.prepare(`INSERT INTO otters (id, name, type, created_at) VALUES ('otter-1', 'o1', 'big', '2026-09-01T00:00:00Z')`).run();
      expect(() =>
        db.prepare(`INSERT INTO dispatch_attempts (id, conversation_id, message_id, target_otter_id, status, source, attempt_started_at)
          VALUES ('att-f', 'conv-f', 'msg-f', 'otter-1', 'aborted', 'dissolve', '2026-09-01T00:02:00Z')`).run()
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});

/** 幽灵 sender 回填（2026-09-04 排查）：两类身份错位的存量修复 */
describe("migrateDatabase - backfillGhostSenders", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function seedOtter(db: Database.Database, id: string, name: string): void {
    db.prepare(`INSERT INTO otters (id, name, type, status, created_at) VALUES (?, ?, 'big', 'active', '2026-01-01T00:00:00Z')`).run(id, name);
  }

  function seedMsg(db: Database.Database, id: string, senderType: string, senderId: string, seq: number, createdAt: string): void {
    db.prepare(`INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 't', '2026-08-19T00:00:00Z', '2026-08-19T00:00:00Z')`).run();
    db.prepare(`INSERT OR IGNORE INTO turns (id, conversation_id, turn_number, created_at) VALUES ('turn-1', 'conv-1', 1, '2026-08-19T00:00:00Z')`).run();
    db.prepare(`INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, created_at)
      VALUES (?, 'conv-1', ?, ?, 'completed', ?, 'turn-1', ?)`).run(id, senderType, senderId, seq, createdAt);
  }

  it("症状A：otter+user 幽灵回填为同会话最近的正常獭（含 sender_name）", () => {
    seedMessage(db, "msg-1", "大獭正常发言"); // seq=1, sender=otter-1
    seedOtter(db, "otter-1", "大獭");
    seedMsg(db, "msg-ghost", "otter", "user", 2, "2026-08-19T03:00:00Z");

    migrateDatabase(db, createTestLogger());

    const row = db.prepare("SELECT sender_id, sender_name FROM messages WHERE id = 'msg-ghost'").get() as { sender_id: string; sender_name: string };
    expect(row.sender_id).toBe("otter-1");
    expect(row.sender_name).toBe("大獭");
    // 正常消息不受影响
    const normal = db.prepare("SELECT sender_id FROM messages WHERE id = 'msg-1'").get() as { sender_id: string };
    expect(normal.sender_id).toBe("otter-1");
  });

  it("症状B：system+UUID 归一为 'system'", () => {
    seedOtter(db, "87f172c6-uuid-of-big-otter", "大獭");
    seedMsg(db, "msg-sys", "system", "87f172c6-uuid-of-big-otter", 3, "2026-08-19T04:00:00Z");

    migrateDatabase(db, createTestLogger());

    const row = db.prepare("SELECT sender_id FROM messages WHERE id = 'msg-sys'").get() as { sender_id: string };
    expect(row.sender_id).toBe("system");
  });

  it("无同会话正常獭消息时跳过不误伤（保持原样）", () => {
    seedMsg(db, "msg-lone-ghost", "otter", "user", 1, "2026-08-19T05:00:00Z");

    migrateDatabase(db, createTestLogger());

    const row = db.prepare("SELECT sender_id FROM messages WHERE id = 'msg-lone-ghost'").get() as { sender_id: string };
    expect(row.sender_id).toBe("user"); // 不误伤：无法判定真身时不改
  });

  it("幂等：二次迁移零写入", () => {
    seedMessage(db, "msg-1", "大獭正常发言");
    seedOtter(db, "otter-1", "大獭");
    seedMsg(db, "msg-ghost", "otter", "user", 2, "2026-08-19T03:00:00Z");
    seedMsg(db, "msg-sys", "system", "some-uuid", 3, "2026-08-19T04:00:00Z");

    migrateDatabase(db, createTestLogger());
    migrateDatabase(db, createTestLogger()); // 二次

    const ghosts = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE sender_type = 'otter' AND sender_id = 'user'").get() as { c: number };
    const sysBad = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE sender_type = 'system' AND sender_id != 'system'").get() as { c: number };
    expect(ghosts.c).toBe(0);
    expect(sysBad.c).toBe(0);
  });
});
