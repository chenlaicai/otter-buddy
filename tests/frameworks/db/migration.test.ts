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


// lint-tests:allow-ddl —— 迁移/恢复测试需要手工建旧 schema 的表（模拟存量库形态）
/**
 * F20260914fkx1：scheduled_task_executions 残留 FK REFERENCES messages(id) 清理
 * 现场（2026-09-14 生产）：#886 批4c drop messages 表后，存量库该表 FK 指向已删表，
 * foreign_keys=ON 时 INSERT 抛 SqliteError: no such table: main.messages，
 * 定时任务 catch-up 全部静默失败（log 887782）。
 */
describe("migrateDatabase - F20260914fkx1: rebuildExecutionsDropMessagesFk", () => {
  /** 模拟存量库：executions 表挂 messages FK + messages 表已 drop（批4c 后形态）。
   *  种子数据在 FK 关闭下插入（生产形态：行是 messages 存活期写入的），插完恢复 ON。 */
  function createStaleFkDb(): Database.Database {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    // initSchema 新库已无 messages 表且 executions 无该 FK——重建旧形态表（FK 指向 messages）
    db.exec("DROP TABLE scheduled_task_executions");
    db.exec(`
      CREATE TABLE scheduled_task_executions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
        triggered_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
        error_message TEXT,
        message_id TEXT REFERENCES messages(id),
        turn_id TEXT REFERENCES turns(id)
      );
    `);
    db.pragma("foreign_keys = OFF");
    db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-fkx', 'FK 测试', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO scheduled_tasks (id, conversation_id, name, cron, body, talking_stone_passed_to, sender_id, timezone, created_at, updated_at)
      VALUES ('task-fkx', 'conv-fkx', 'FK 任务', '0 9 * * *', 'x', '[]', 'otter-1', 'Asia/Shanghai', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO scheduled_task_executions (id, task_id, triggered_at, status)
      VALUES ('exec-fkx-1', 'task-fkx', '2026-09-13T09:00:00Z', 'skipped')`).run();
    db.pragma("foreign_keys = ON");
    return db;
  }

  it("存量库：FK 指向已 drop 的 messages 表 → INSERT 炸 no such table（现场复现）", () => {
    const db = createStaleFkDb();
    try {
      // 迁移前复现生产现场：prepare 阶段抛 no such table: main.messages
      expect(() =>
        db.prepare(`INSERT INTO scheduled_task_executions (id, task_id, triggered_at, status) VALUES ('exec-new', 'task-fkx', '2026-09-14T01:21:00Z', 'running')`).run()
      ).toThrow(/no such table: main\.messages/);
    } finally {
      db.close();
    }
  });

  it("迁移后：残留 FK 被清，INSERT 恢复 + 存量数据保留 + 幂等", () => {
    const db = createStaleFkDb();
    try {
      migrateDatabase(db, createTestLogger());

      // INSERT 不再炸（迁移后 FK 已去）
      expect(() =>
        db.prepare(`INSERT INTO scheduled_task_executions (id, task_id, triggered_at, status) VALUES ('exec-new', 'task-fkx', '2026-09-14T01:21:00Z', 'running')`).run()
      ).not.toThrow();

      // 存量数据完整保留
      const row = db.prepare("SELECT status FROM scheduled_task_executions WHERE id = 'exec-fkx-1'").get() as { status: string };
      expect(row.status).toBe("skipped");

      // FK 已不指向 messages
      const fks = db.prepare("PRAGMA foreign_key_list(scheduled_task_executions)").all() as Array<{ table: string }>;
      expect(fks.some(fk => fk.table === "messages")).toBe(false);

      // 索引重建
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_executions_task'").get();
      expect(idx).toBeTruthy();

      // 幂等：二次迁移不报错不重复重建（检视建议 1：另验数据完整——二次迁移后存量行仍在、计数不变）
      expect(() => migrateDatabase(db, createTestLogger())).not.toThrow();
      const row2 = db.prepare("SELECT status FROM scheduled_task_executions WHERE id = 'exec-fkx-1'").get() as { status: string };
      expect(row2.status).toBe("skipped");
      const count2 = db.prepare("SELECT COUNT(*) AS c FROM scheduled_task_executions").get() as { c: number };
      expect(count2.c).toBe(2); // exec-fkx-1 + exec-new（测试 2 前段已插入）
    } finally {
      db.close();
    }
  });

  it("全新库（无残留 FK）：迁移直接通过，无需重建", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      migrateDatabase(db, createTestLogger());
      db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-fresh-fkx', '新库', '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z')`).run();
      db.prepare(`INSERT INTO scheduled_tasks (id, conversation_id, name, cron, body, talking_stone_passed_to, sender_id, timezone, created_at, updated_at)
        VALUES ('task-fresh-fkx', 'conv-fresh-fkx', '新库任务', '0 9 * * *', 'x', '[]', 'otter-1', 'Asia/Shanghai', '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z')`).run();
      expect(() =>
        db.prepare(`INSERT INTO scheduled_task_executions (id, task_id, triggered_at, status) VALUES ('exec-fresh-fkx', 'task-fresh-fkx', '2026-09-14T00:00:00Z', 'running')`).run()
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});

/** F20260915midu（#942）：记忆投影条目主键统一为 source_id 的存量迁移。
 *  验证：id 换键、edges 重定向（含重复边去重）、卫星表（weights/FTS/embedding_tasks）
 *  键复制、豁免类（signals-fact / chunk）不动、幂等。 */
describe("migrateDatabase - F20260915midu: rebuildMemoryEntriesUnifyIds", () => {
  /** 模拟迁移前形态：initSchema 建新库结构，再手工把可统一类条目的 id 改成
   *  与 source_id 不同的旧 UUID（模拟双 ID 存量），并种 edges/weights/FTS/tasks。 */
  function createLegacyDualIdDb(): Database.Database {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 'c', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`).run();

    const insertEntry = db.prepare(`
      INSERT INTO memory_entries (id, layer, content_type, source_id, source_table, conversation_id, granularity, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertFts = db.prepare("INSERT INTO memory_fts_jieba (memory_entry_id, content) VALUES (?, ?)");
    const insertWeights = db.prepare("INSERT INTO memory_weights (memory_entry_id, retrieval_count, last_retrieved_at, user_flagged) VALUES (?, 0, NULL, 0)");

    // 可统一类（旧双 ID 形态）：id != source_id
    // linked_resource：资源 ID res-001，投影旧 ID old-proj-res
    insertEntry.run("old-proj-res", "working", "linked_resource", "res-001", "linked_resources", "conv-1", "coarse", "资源内容", null, "2026-09-01T00:00:00Z");
    insertFts.run("old-proj-res", "资源 内容");
    insertWeights.run("old-proj-res");
    // feature：文档 F20260915aaaa，投影旧 ID old-proj-feat
    insertEntry.run("old-proj-feat", "document", "feature", "F20260915aaaa", "features", null, "coarse", "文档 summary", null, "2026-09-01T00:00:00Z");
    insertFts.run("old-proj-feat", "文档 summary");
    insertWeights.run("old-proj-feat");
    // message：消息 msg-001，投影旧 ID old-proj-msg
    insertEntry.run("old-proj-msg", "working", "message", "msg-001", "messages", "conv-1", "fine", "消息内容", null, "2026-09-01T00:00:00Z");
    insertFts.run("old-proj-msg", "消息 内容");
    insertWeights.run("old-proj-msg");

    // 豁免类：signals-fact（id != source_id 但不应迁移）
    insertEntry.run("sig-fact-uuid", "working", "fact", "126", "signals", null, "coarse", "信号内容", null, "2026-09-01T00:00:00Z");
    insertFts.run("sig-fact-uuid", "信号 内容");
    insertWeights.run("sig-fact-uuid");
    // 豁免类：chunk（id != source_id 但不应迁移）
    // 注：content/FTS 用与 feature 不同的文本——迁移前的 normalize 步会按同 source 组
    // 清理冗余行，若 chunk 与 feature 共用同文本会被误判（现实库中 chunk 是文档段落，
    // 与 summary 文本不同；此处对齐现实形态）。
    insertEntry.run("chunk-uuid-1", "document", "feature_chunk", "F20260915aaaa", "features", null, "fine", "chunk 正文段落", null, "2026-09-01T00:00:00Z");
    insertFts.run("chunk-uuid-1", "chunk 正文 段落");
    insertWeights.run("chunk-uuid-1");

    // embedding_tasks 挂在可统一类旧 ID 上
    db.prepare(`INSERT INTO embedding_tasks (entry_id, attempts, last_error, last_attempt_at, next_retry_at, status, created_at)
      VALUES ('old-proj-res', 1, 'embed failed', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', 'pending', '2026-09-01T00:00:00Z')`).run();

    // edges：
    // 1) old-proj-msg -[produced]-> old-proj-res（两端都要重定向）
    db.prepare(`INSERT INTO memory_edges (id, from_entry_id, to_entry_id, edge_type, metadata, created_at, created_by)
      VALUES ('edge-1', 'old-proj-msg', 'old-proj-res', 'produced', NULL, '2026-09-01T00:00:00Z', 'test')`).run();
    // 2) old-proj-res -[references]-> old-proj-feat
    db.prepare(`INSERT INTO memory_edges (id, from_entry_id, to_entry_id, edge_type, metadata, created_at, created_by)
      VALUES ('edge-2', 'old-proj-res', 'old-proj-feat', 'references', NULL, '2026-09-01T00:00:00Z', 'test')`).run();
    // 3) 涉及豁免类的边（signals-fact 端不动，可统一端重定向）
    db.prepare(`INSERT INTO memory_edges (id, from_entry_id, to_entry_id, edge_type, metadata, created_at, created_by)
      VALUES ('edge-3', 'sig-fact-uuid', 'old-proj-res', 'relates-to', NULL, '2026-09-01T00:00:00Z', 'test')`).run();
    return db;
  }

  it("迁移后：可统一类 id == source_id，豁免类不动", () => {
    const db = createLegacyDualIdDb();
    try {
      migrateDatabase(db, createTestLogger());

      // 可统一类：新主键 = source_id，内容/FTS 不丢
      const res = db.prepare("SELECT id, source_id, content FROM memory_entries WHERE source_table='linked_resources'").get() as { id: string; source_id: string; content: string };
      expect(res.id).toBe("res-001");
      expect(res.content).toBe("资源内容");
      const feat = db.prepare("SELECT id FROM memory_entries WHERE content_type='feature'").get() as { id: string };
      expect(feat.id).toBe("F20260915aaaa");
      const msg = db.prepare("SELECT id FROM memory_entries WHERE source_table='messages'").get() as { id: string };
      expect(msg.id).toBe("msg-001");
      // 旧 ID 不再存在
      const orphans = db.prepare("SELECT COUNT(*) AS c FROM memory_entries WHERE id IN ('old-proj-res','old-proj-feat','old-proj-msg')").get() as { c: number };
      expect(orphans.c).toBe(0);

      // 豁免类：signals-fact 与 chunk 保持原 ID
      const sig = db.prepare("SELECT id FROM memory_entries WHERE source_table='signals'").get() as { id: string };
      expect(sig.id).toBe("sig-fact-uuid");
      const chunk = db.prepare("SELECT id FROM memory_entries WHERE content_type='feature_chunk'").get() as { id: string };
      expect(chunk.id).toBe("chunk-uuid-1");

      // FTS 键跟随（新键可检索、旧键清除）
      const ftsNew = db.prepare("SELECT COUNT(*) AS c FROM memory_fts_jieba WHERE memory_entry_id='res-001'").get() as { c: number };
      expect(ftsNew.c).toBe(1);
      const ftsOld = db.prepare("SELECT COUNT(*) AS c FROM memory_fts_jieba WHERE memory_entry_id='old-proj-res'").get() as { c: number };
      expect(ftsOld.c).toBe(0);

      // weights 键跟随
      const wNew = db.prepare("SELECT COUNT(*) AS c FROM memory_weights WHERE memory_entry_id='F20260915aaaa'").get() as { c: number };
      expect(wNew.c).toBe(1);

      // embedding_tasks 键跟随（pending 任务不丢）
      const task = db.prepare("SELECT entry_id, status FROM embedding_tasks").get() as { entry_id: string; status: string };
      expect(task.entry_id).toBe("res-001");
      expect(task.status).toBe("pending");
    } finally {
      db.close();
    }
  });

  it("迁移后：edges 两端重定向（含豁免类端不动）", () => {
    const db = createLegacyDualIdDb();
    try {
      migrateDatabase(db, createTestLogger());

      const edges = db.prepare("SELECT id, from_entry_id, to_entry_id, edge_type FROM memory_edges ORDER BY id").all() as Array<{ id: string; from_entry_id: string; to_entry_id: string; edge_type: string }>;
      expect(edges).toHaveLength(3);
      // edge-1：两端重定向
      const e1 = edges.find(e => e.id === "edge-1")!;
      expect([e1.from_entry_id, e1.to_entry_id]).toEqual(["msg-001", "res-001"]);
      // edge-2：保留，重定向
      const e2 = edges.find(e => e.id === "edge-2")!;
      expect([e2.from_entry_id, e2.to_entry_id]).toEqual(["res-001", "F20260915aaaa"]);
      // edge-3：豁免端不动，可统一端重定向
      const e3 = edges.find(e => e.id === "edge-3")!;
      expect([e3.from_entry_id, e3.to_entry_id]).toEqual(["sig-fact-uuid", "res-001"]);
    } finally {
      db.close();
    }
  });

  it("幂等：二次迁移零变化（无可迁移行直接返回）", () => {
    const db = createLegacyDualIdDb();
    try {
      migrateDatabase(db, createTestLogger());
      const snapshot = (sql: string) => (db.prepare(sql).all() as unknown[]).length;
      const counts1 = {
        entries: snapshot("SELECT * FROM memory_entries"),
        edges: snapshot("SELECT * FROM memory_edges"),
        weights: snapshot("SELECT * FROM memory_weights"),
        fts: snapshot("SELECT * FROM memory_fts_jieba"),
        tasks: snapshot("SELECT * FROM embedding_tasks"),
      };
      expect(() => migrateDatabase(db, createTestLogger())).not.toThrow();
      expect(snapshot("SELECT * FROM memory_entries")).toBe(counts1.entries);
      expect(snapshot("SELECT * FROM memory_edges")).toBe(counts1.edges);
      expect(snapshot("SELECT * FROM memory_weights")).toBe(counts1.weights);
      expect(snapshot("SELECT * FROM memory_fts_jieba")).toBe(counts1.fts);
      expect(snapshot("SELECT * FROM embedding_tasks")).toBe(counts1.tasks);
    } finally {
      db.close();
    }
  });

  it("迁移后：统一 ID 支持 link_memory 语义（资源 ID 直查命中 + 对资源 ID 建边）", () => {
    const db = createLegacyDualIdDb();
    try {
      migrateDatabase(db, createTestLogger());
      // 资源 ID 直查命中（#942 的核心验收）
      const hit = db.prepare("SELECT id FROM memory_entries WHERE id = 'res-001'").get();
      expect(hit).toBeTruthy();
      // 对资源 ID 建边成功（FK 约束下新边可落）
      expect(() =>
        db.prepare(`INSERT INTO memory_edges (id, from_entry_id, to_entry_id, edge_type, created_at)
          VALUES ('edge-new', 'res-001', 'msg-001', 'references', '2026-09-02T00:00:00Z')`).run()
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("全新库（无双 ID 存量）：迁移直接通过零副作用", () => {
    const db = createTestDb();
    try {
      expect(() => migrateDatabase(db, createTestLogger())).not.toThrow();
      const c = db.prepare("SELECT COUNT(*) AS c FROM memory_entries").get() as { c: number };
      expect(c.c).toBe(0);
    } finally {
      db.close();
    }
  });
});

/** F20260915midu 检视严重发现 1 回归：post-migration replaceBySource 重入（同 id 快路径）。
 *  迁移后 feature entry id = source_id，replaceEntryBySource 先插后删会撞 UNIQUE 主键——
 *  修复为同 id 走快路径（边 remap 是 no-op，直接级联删 + 删旧 + 插新）。
 *  本用例锁死「迁移 → sync_docs reindex」端到端衔接面。 */
describe("migrateDatabase - F20260915midu: post-migration replaceBySource re-entry", () => {
  it("迁移后同 id replaceEntryBySource 不撞 UNIQUE，边与内容正确", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    try {
      db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 'c', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`).run();
      const insertEntry = db.prepare(`INSERT INTO memory_entries (id, layer, content_type, source_id, source_table, conversation_id, granularity, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertFts = db.prepare("INSERT INTO memory_fts_jieba (memory_entry_id, content) VALUES (?, ?)");
      const insertWeights = db.prepare("INSERT INTO memory_weights (memory_entry_id, retrieval_count, last_retrieved_at, user_flagged) VALUES (?, 0, NULL, 0)");
      // 迁移前双 ID 形态：feature 投影旧 id，消息投影旧 id
      insertEntry.run("old-proj-feat", "document", "feature", "F20260915bbbb", "features", null, "coarse", "文档 v1", null, "2026-09-01T00:00:00Z");
      insertFts.run("old-proj-feat", "文档 v1");
      insertWeights.run("old-proj-feat");
      insertEntry.run("old-proj-msg", "working", "message", "msg-001", "messages", "conv-1", "fine", "讨论", null, "2026-09-01T00:00:00Z");
      insertFts.run("old-proj-msg", "讨论");
      insertWeights.run("old-proj-msg");
      db.prepare(`INSERT INTO memory_edges (id, from_entry_id, to_entry_id, edge_type, created_at) VALUES ('edge-1', 'old-proj-msg', 'old-proj-feat', 'produced', '2026-09-01T00:00:00Z')`).run();

      // 迁移：id 统一（feature id 变为 F20260915bbbb，边重定向）
      migrateDatabase(db, createTestLogger());
      expect((db.prepare("SELECT id FROM memory_entries WHERE content_type='feature'").get() as { id: string }).id).toBe("F20260915bbbb");

      // 迁移后 sync_docs reindex：同 id 重入（检视严重发现 1 的 100% 复现路径）
      const { SqliteMemoryRepository } = await import("@frameworks/db/memory/sqlite-memory-repository");
      const repo = new SqliteMemoryRepository(db);
      await repo.replaceEntryBySource({
        id: "F20260915bbbb",
        layer: "document",
        contentType: "feature",
        sourceId: "F20260915bbbb",
        sourceTable: "features",
        conversationId: null,
        granularity: "coarse",
        content: "文档 v2",
        metadata: null,
        createdAt: "2026-09-15T13:00:00Z",
      });

      // 内容更新、边保留（重定向到同 id 是 no-op）
      const feat = db.prepare("SELECT content FROM memory_entries WHERE id = 'F20260915bbbb'").get() as { content: string };
      expect(feat.content).toBe("文档 v2");
      const edge = db.prepare("SELECT from_entry_id, to_entry_id FROM memory_edges WHERE id = 'edge-1'").get() as { from_entry_id: string; to_entry_id: string };
      expect([edge.from_entry_id, edge.to_entry_id]).toEqual(["msg-001", "F20260915bbbb"]);
      // FTS/weights 卫星表重建
      expect((db.prepare("SELECT COUNT(*) c FROM memory_fts_jieba WHERE memory_entry_id = 'F20260915bbbb'").get() as { c: number }).c).toBe(1);
      expect((db.prepare("SELECT COUNT(*) c FROM memory_weights WHERE memory_entry_id = 'F20260915bbbb'").get() as { c: number }).c).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("migrateDatabase - F20260915desc scheduled_tasks.description 列", () => {
  it("老库无 description 列：migrate 补列，跑两次不报错（幂等）", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      db.exec("ALTER TABLE scheduled_tasks DROP COLUMN description");
      const before = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as Array<{ name: string }>;
      expect(before.some(c => c.name === "description")).toBe(false);

      migrateDatabase(db, createTestLogger());
      const after = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as Array<{ name: string }>;
      expect(after.some(c => c.name === "description")).toBe(true);
      migrateDatabase(db, createTestLogger()); // 幂等
    } finally {
      db.close();
    }
  });

  it("回填 paper-trading 两个 seed 任务描述（按 name 幂等，不覆盖已有非空描述）", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);

      // 准备 conversations 行满足 FK
      db.prepare(
        "INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', '纸面交易', 'active', '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z')",
      ).run();

      // 插入两条 seed 任务（description 为 NULL 模拟老库）+ 一条已有自定义描述（不应被覆盖）
      const insert = db.prepare(`
        INSERT INTO scheduled_tasks (
          id, conversation_id, name, cron, timezone, body,
          talking_stone_passed_to, sender_id, status, created_at, updated_at
        ) VALUES (?, 'conv-1', ?, '5 15 * * 1-5', 'Asia/Shanghai', '{}', '[]', 'system', 'active', '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z')
      `);
      insert.run("task-1", "paper-trading-match-orders");
      insert.run("task-2", "paper-trading-daily-trading");
      insert.run("task-3", "unrelated-task");

      // 手工设置 task-3 已有描述，验证不被覆盖
      db.prepare("UPDATE scheduled_tasks SET description = '自定义描述' WHERE id = 'task-3'").run();

      migrateDatabase(db, createTestLogger());

      const t1 = db.prepare("SELECT description FROM scheduled_tasks WHERE id = 'task-1'").get() as { description: string | null };
      const t2 = db.prepare("SELECT description FROM scheduled_tasks WHERE id = 'task-2'").get() as { description: string | null };
      const t3 = db.prepare("SELECT description FROM scheduled_tasks WHERE id = 'task-3'").get() as { description: string | null };

      expect(t1.description).toContain("撮合");
      expect(t2.description).toContain("操盘獭");
      expect(t3.description).toBe("自定义描述"); // 已有描述不被覆盖

      // 幂等：二次迁移不覆盖（若用户手工改过描述）
      db.prepare("UPDATE scheduled_tasks SET description = '用户改过' WHERE id = 'task-1'").run();
      migrateDatabase(db, createTestLogger());
      const t1Again = db.prepare("SELECT description FROM scheduled_tasks WHERE id = 'task-1'").get() as { description: string | null };
      expect(t1Again.description).toBe("用户改过");
    } finally {
      db.close();
    }
  });

  it("老库迁移后 description 列带 CHECK 约束：501 字符落库被拒（发现 1 修复验证）", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      db.exec("ALTER TABLE scheduled_tasks DROP COLUMN description");

      migrateDatabase(db, createTestLogger());

      db.prepare(
        "INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', 't', 'active', '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z')",
      ).run();
      db.prepare(`
        INSERT INTO scheduled_tasks (id, conversation_id, name, cron, timezone, body,
          talking_stone_passed_to, sender_id, status, created_at, updated_at)
        VALUES ('t1', 'conv-1', 'n', '0 9 * * *', 'Asia/Shanghai', 'b', '[]', 'system', 'active', '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z')
      `).run();

      // 500 字符合法
      expect(() => {
        db.prepare("UPDATE scheduled_tasks SET description = ? WHERE id = 't1'").run('x'.repeat(500));
      }).not.toThrow();

      // 501 字符被 CHECK 拒绝
      expect(() => {
        db.prepare("UPDATE scheduled_tasks SET description = ? WHERE id = 't1'").run('x'.repeat(501));
      }).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });
});
