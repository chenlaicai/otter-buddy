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


describe("migrateDatabase - F20260728htar 补丁", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
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
        message_id TEXT,
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

describe("migrateDatabase - F20260908rlcp: dispatch_attempts table drop", () => {
  /** 模拟旧库：dispatch_attempts 存在（存量库） */
  function createOldSchemaDb(): Database.Database {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    // F20260908rlcp：dispatch_attempts 已从 initSchema 退役，手动创建模拟存量库
    db.exec(`CREATE TABLE IF NOT EXISTS dispatch_attempts (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, target_otter_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('in_progress','completed','failed','aborted')), source TEXT NOT NULL DEFAULT 'chain' CHECK (source IN ('chain','router','retry','backfill')), attempt_started_at TEXT NOT NULL DEFAULT (datetime('now')), attempt_finished_at TEXT, note TEXT, UNIQUE(message_id, target_otter_id), FOREIGN KEY (conversation_id) REFERENCES conversations(id))`);
    // 父表先 seed（FK 验证用）——messages 已退役（F20260913ctlv 批4c），message_id 为弱引用文本
    db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-m', 't', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO otters (id, name, type, created_at) VALUES ('otter-1', 'o1', 'big', '2026-09-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO dispatch_attempts (id, conversation_id, message_id, target_otter_id, status, source, attempt_started_at, note)
      VALUES ('att-m', 'conv-m', 'msg-m', 'otter-1', 'failed', 'chain', '2026-09-01T00:02:00Z', '旧账')`).run();
    return db;
  }

  it("存量库：dispatch_attempts 表被 drop（退役清理）", () => {
    const db = createOldSchemaDb();
    try {
      // 迁移前：表存在
      const before = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='dispatch_attempts'").get() as { n: number };
      expect(before.n).toBe(1);

      migrateDatabase(db, createTestLogger());

      // 迁移后：表被 drop
      const after = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='dispatch_attempts'").get() as { n: number };
      expect(after.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("幂等：二次迁移不报错（表不存在时跳过 drop）", () => {
    const db = createOldSchemaDb();
    try {
      migrateDatabase(db, createTestLogger());
      // 第二次迁移：表已不存在，dropDispatchAttemptsTable 幂等跳过
      expect(() => migrateDatabase(db, createTestLogger())).not.toThrow();
      // 验证表仍不存在
      const after = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='dispatch_attempts'").get() as { n: number };
      expect(after.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("全新库（dispatch_attempts 不存在）：迁移直接通过，不报错", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      // 全新库无 dispatch_attempts 表（F20260908rlcp 退役）
      // 迁移中的 dropDispatchAttemptsTable 检测表不存在后跳过
      expect(() => migrateDatabase(db, createTestLogger())).not.toThrow();
      // 验证表不存在（退役后新库不建此表）
      const row = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='dispatch_attempts'").get() as { n: number };
      expect(row.n).toBe(0);
    } finally {
      db.close();
    }
  });
});

