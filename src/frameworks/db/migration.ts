/**
 * 数据库迁移：Session 复用机制
 */

import type Database from "better-sqlite3";
import type { Logger } from "@usecases/ports/logger";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";
import { stripHtmlCardFences } from "@entities/conversation/message-body-projection";

/** 数据库迁移：添加 session_file 字段和 otter_configs 表 */
// eslint-disable-next-line max-statements -- 补丁集合，语句数由历史补丁数决定
export function migrateDatabase(db: Database.Database, logger: Logger): void {
  // 检查 session_file 字段是否存在
  const columns = db.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>;
  const hasSessionFile = columns.some(col => col.name === 'session_file');

  if (!hasSessionFile) {
    db.prepare("ALTER TABLE agent_sessions ADD COLUMN session_file TEXT NOT NULL DEFAULT ''").run();
    logger.info('Added session_file column to agent_sessions table');
  }

  // 检查 messages 表的 source 字段是否存在
  const msgColumns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  const hasSource = msgColumns.some(col => col.name === 'source');

  if (!hasSource) {
    db.prepare("ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'web'").run();
    logger.info('Added source column to messages table');
  }

  // 创建 otter_configs 表
  db.prepare(`
    CREATE TABLE IF NOT EXISTS otter_configs (
      otter_id TEXT PRIMARY KEY,
      system_prompt TEXT,
      otter_type TEXT NOT NULL DEFAULT 'big' CHECK(otter_type IN ('big', 'small')),
      model_alias TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  logger.info('Ensured otter_configs table exists');

  // 检查 model_alias 列是否存在（为已存在的表添加列）
  const otterConfigColumns = db.prepare("PRAGMA table_info(otter_configs)").all() as Array<{ name: string }>;
  const hasModelAlias = otterConfigColumns.some(col => col.name === 'model_alias');

  if (!hasModelAlias) {
    db.prepare("ALTER TABLE otter_configs ADD COLUMN model_alias TEXT").run();
    logger.info('Added model_alias column to otter_configs table');
  }

  // 检查 last_read_turn_number 字段是否存在
  const participantColumns = db.prepare("PRAGMA table_info(conversation_participants)").all() as Array<{ name: string }>;
  const hasLastRead = participantColumns.some(col => col.name === 'last_read_turn_number');

  if (!hasLastRead) {
    db.prepare("ALTER TABLE conversation_participants ADD COLUMN last_read_turn_number INTEGER NOT NULL DEFAULT 0").run();
    logger.info('Added last_read_turn_number column to conversation_participants table');
  }

  /** F20260728htar 一次性补丁 */
  rebuildMessagesFtsStripped(db, logger);
  dropMessagesAttachmentsColumn(db, logger);
  addPinnedColumn(db, logger);

  /** F20260803mval 一次性补丁：移除文档表枚举 CHECK 约束 */
  rebuildDocumentTablesDropCheck(db, logger);

  /** F20260803fbit: features/research 表加 body_hash 列（驱动 upsert 指纹比较） */
  addBodyHashColumns(db, logger);
}

/**
 * F20260803fbit: 为 features/research 表加 body_hash 列。
 * 老库已跑过 rebuildDocumentTablesDropCheck（标记 done 不会重建），
 * 需要独立 ADD COLUMN 补列。PRAGMA table_info 检测列存在性作幂等。
 */
function addBodyHashColumns(db: Database.Database, logger: Logger): void {
  const featuresCols = db.prepare("PRAGMA table_info(features)").all() as Array<{ name: string }>;
  if (!featuresCols.some(col => col.name === 'body_hash')) {
    db.prepare("ALTER TABLE features ADD COLUMN body_hash TEXT").run();
    logger.info('Added body_hash column to features table');
  }

  const researchCols = db.prepare("PRAGMA table_info(research)").all() as Array<{ name: string }>;
  if (!researchCols.some(col => col.name === 'body_hash')) {
    db.prepare("ALTER TABLE research ADD COLUMN body_hash TEXT").run();
    logger.info('Added body_hash column to research table');
  }
}

/**
 * F20260728htar 补丁（a）：存量 FTS rebuild 为剥离投影。
 * FTS 写入从触发器拿回应用层后，messages_fts.body 存 html-card 剥离文本。
 * 单事务内 DELETE + 逐条剥离重插；settings 表 messages_fts_stripped_rebuild=done
 * 作幂等键（initSchema 的 DROP TRIGGER 先于 migrateDatabase，"触发器存在"不能作判据）。
 * 注：html-card 是本特性新语法，历史消息本无此类围栏，rebuild 实为防御性一致性措施。
 */
function rebuildMessagesFtsStripped(db: Database.Database, logger: Logger): void {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'messages_fts_stripped_rebuild'")
    .get() as { value: string } | undefined;
  if (done?.value === 'done') return;

  const rebuild = db.transaction(() => {
    db.prepare("DELETE FROM messages_fts").run();
    const rows = db.prepare("SELECT id, body FROM messages").all() as Array<{ id: string; body: string | null }>;
    const insert = db.prepare("INSERT INTO messages_fts (message_id, body) VALUES (?, ?)");
    for (const row of rows) {
      /** COALESCE(null,'') 语义：body 为 null 的 streaming 消息索引空串 */
      insert.run(row.id, row.body === null ? '' : stripHtmlCardFences(row.body));
    }
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('messages_fts_stripped_rebuild', 'done', datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = 'done', updated_at = datetime('now')",
    ).run();
  });
  rebuild();
  logger.info('Rebuilt messages_fts with stripped projection (messages_fts_stripped_rebuild=done)');
}

/**
 * F20260728htar 补丁（b）：messages 表 DROP COLUMN attachments（死字段清除）。
 * 以 PRAGMA 探测列存在性作天然幂等（DROP COLUMN 需 SQLite 3.35+，better-sqlite3 捆绑版本满足）。
 */
function dropMessagesAttachmentsColumn(db: Database.Database, logger: Logger): void {
  const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  const hasAttachments = columns.some(col => col.name === 'attachments');
  if (!hasAttachments) return;

  db.prepare("ALTER TABLE messages DROP COLUMN attachments").run();
  logger.info('Dropped attachments column from messages table');
}

/** F20260803pncv：conversations 表添加 pinned 列（置顶功能）。PRAGMA 探测幂等。 */
function addPinnedColumn(db: Database.Database, logger: Logger): void {
  const columns = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
  const hasPinned = columns.some(col => col.name === 'pinned');
  if (hasPinned) return;

  db.prepare("ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0").run();
  logger.info('Added pinned column to conversations table');
}

/**
 * F20260803mval 补丁：重建 features/research 表移除枚举 CHECK 约束。
 * SQLite 不支持 ALTER TABLE DROP CHECK，必须 CREATE new -> INSERT FROM old -> DROP old -> RENAME。
 * settings 表 doc_check_constraints_dropped=done 作幂等键。
 * 新表定义与 schema.ts createDocumentTables 一致（无 change_type/status/exploration_type 的枚举 CHECK）。
 * 枚举合法性改由应用层 known-values.ts 单一真相源判定。
 */
// eslint-disable-next-line max-lines-per-function -- 表重建含 CREATE/INSERT/DROP/RENAME 四步，拆分降低可读性
function rebuildDocumentTablesDropCheck(db: Database.Database, logger: Logger): void {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'doc_check_constraints_dropped'")
    .get() as { value: string } | undefined;
  if (done?.value === 'done') return;

  // 检测旧 CHECK 约束是否存在（通过 sqlite_master 的 schema 文本）
  const featuresSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='features'")
    .get() as { sql: string } | undefined;
  const hasFeaturesCheck = featuresSchema?.sql?.includes("CHECK(change_type IN") ?? false;

  const researchSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='research'")
    .get() as { sql: string } | undefined;
  const hasResearchCheck = researchSchema?.sql?.includes("CHECK(exploration_type IN") ?? false;

  const markDone = () => db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('doc_check_constraints_dropped', 'done', datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value='done', updated_at=datetime('now')"
  ).run();

  if (!hasFeaturesCheck && !hasResearchCheck) {
    // 全新库（initSchema 已建无 CHECK 表）或已迁移，标记 done
    markDone();
    return;
  }

  const rebuild = db.transaction(() => {
    if (hasFeaturesCheck) {
      db.exec(`
        CREATE TABLE features_new (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 500),
          body_hash TEXT,
          change_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          tags TEXT NOT NULL DEFAULT '[]',
          modules TEXT NOT NULL DEFAULT '[]',
          causal_links_from TEXT NOT NULL DEFAULT '[]',
          supersedes TEXT NOT NULL DEFAULT '[]',
          file_path TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK(id LIKE 'F%')
        );
        INSERT INTO features_new (id, title, summary, change_type, status, tags, modules, causal_links_from, supersedes, file_path, created_at)
        SELECT id, title, summary, change_type, status, tags, modules, causal_links_from, supersedes, file_path, created_at FROM features;
        DROP TABLE features;
        ALTER TABLE features_new RENAME TO features;
        CREATE INDEX IF NOT EXISTS idx_features_status ON features(status);
        CREATE INDEX IF NOT EXISTS idx_features_created_at ON features(created_at);
      `);
    }
    if (hasResearchCheck) {
      db.exec(`
        CREATE TABLE research_new (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 500),
          body_hash TEXT,
          exploration_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          tags TEXT NOT NULL DEFAULT '[]',
          conclusion TEXT,
          causal_links_from TEXT NOT NULL DEFAULT '[]',
          supersedes TEXT NOT NULL DEFAULT '[]',
          file_path TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK(id LIKE 'R%')
        );
        INSERT INTO research_new (id, title, summary, exploration_type, status, tags, conclusion, causal_links_from, supersedes, file_path, created_at)
        SELECT id, title, summary, exploration_type, status, tags, conclusion, causal_links_from, supersedes, file_path, created_at FROM research;
        DROP TABLE research;
        ALTER TABLE research_new RENAME TO research;
        CREATE INDEX IF NOT EXISTS idx_research_status ON research(status);
        CREATE INDEX IF NOT EXISTS idx_research_created_at ON research(created_at);
        CREATE INDEX IF NOT EXISTS idx_research_exploration_type ON research(exploration_type);
      `);
    }
    markDone();
  });
  rebuild();
  logger.info('Rebuilt features/research tables to drop CHECK constraints (doc_check_constraints_dropped=done)');
}

/** 迁移现有数据：为现有 session 创建 OtterConfig */
export function migrateExistingData(
  db: Database.Database,
  otterConfigProvider: OtterConfigProvider,
  logger: Logger,
): void {
  // 检查是否有需要迁移的数据
  const existingSessions = db.prepare(
    "SELECT otter_id, pi_session_id FROM agent_sessions WHERE session_file = ''"
  ).all() as Array<{ otter_id: string; pi_session_id: string }>;

  if (existingSessions.length === 0) {
    logger.info('No existing sessions to migrate');
    return;
  }

  logger.info(`Migrating ${existingSessions.length} existing sessions`);

  // 为每个 session 创建 OtterConfig
  for (const session of existingSessions) {
    // 从 otters 表获取 otterType
    const otter = db.prepare(
      "SELECT type FROM otters WHERE id = ?"
    ).get(session.otter_id) as { type: string } | undefined;

    if (otter) {
      otterConfigProvider.setConfig(session.otter_id, {
        otterType: otter.type as 'big' | 'small',
        // systemPrompt 为 undefined，因为当前代码存储在内存 Map 中，无法迁移
      });
    }
  }

  logger.warn('Migration completed. IMPORTANT: All old sessions will be recreated on first invoke. Previous session context and system prompts will be lost. You need to reconfigure system prompts after migration.');
}

/**
 * F20260803chunk: 清理旧 feature_body/research_body entries（chunking 取代整 body entry，决策 D1）。
 *
 * B7：独立 export 函数，不加入 migrateDatabase 函数体（migrateDatabase 在 sync 之前执行）。
 *     在 main.ts 中 syncDocuments 之后单独调用。
 * B3：sync 之前调用会删旧数据，sync 失败则正文索引消失；移到 sync 之后则 sync 失败旧数据还在。
 * M14：加 syncErrors 参数，仅当 sync 无错误时执行清理。防 sync 部分失败时清掉失败文档正文索引。
 * S10：vec 删除 try-catch 加 log warn（防吞非 table-not-found 错误）。
 */
export function migrateFeatureBodyToChunks(db: Database.Database, logger: Logger, syncErrors: number): void {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'chunking_v1_migrated'")
    .get() as { value: string } | undefined;
  if (done?.value === 'done') return;

  // M14：sync 有错误时不执行清理（防失败文档正文索引永久消失）
  if (syncErrors > 0) {
    logger.warn(`Skipping chunking migration: sync had ${syncErrors} errors, will retry next startup`);
    return;
  }

  const migrate = db.transaction(() => {
    const types = ["feature_body", "research_body"];
    for (const ct of types) {
      const rows = db.prepare("SELECT id FROM memory_entries WHERE content_type = ?").all(ct) as Array<{ id: string }>;
      for (const row of rows) {
        db.prepare("DELETE FROM memory_fts WHERE memory_entry_id = ?").run(row.id);
        // S10：vec 删除 try-catch 加 log warn（vec0 表可能不存在，D22 降级）
        try {
          db.prepare("DELETE FROM memory_vec WHERE memory_entry_id = ?").run(row.id);
        } catch (e) {
          logger.warn(`migrateFeatureBodyToChunks: memory_vec delete failed for ${row.id}: ${e}`);
        }
        db.prepare("DELETE FROM memory_weights WHERE memory_entry_id = ?").run(row.id);
      }
      db.prepare("DELETE FROM memory_entries WHERE content_type = ?").run(ct);
    }
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('chunking_v1_migrated', 'done', datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = 'done', updated_at = datetime('now')",
    ).run();
  });
  migrate();
  logger.info('Migrated feature_body/research_body entries to chunk model (chunking_v1_migrated=done)');
}
