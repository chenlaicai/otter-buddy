/**
 * 数据库迁移：Session 复用机制。#506 后未达 max-lines 阈值——若未来补丁增长再次超限，
 * 可按 schema.ts 先例恢复 eslint-disable max-lines（补丁集合文件，行数由历史补丁数决定）。
 */

import type Database from "better-sqlite3";
import type { Logger } from "@usecases/ports/logger";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";
import { stripHtmlCardFences } from "@entities/conversation/message-body-projection";

/** 数据库迁移：添加 session_file 字段和 otter_configs 表 */
// eslint-disable-next-line max-statements -- 补丁集合，语句数由历史补丁数决定（max-lines-per-function #506 后未超限）
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

  // sender_name: 发送者显示名快照（F20260824snrs 单一真相源）
  const hasSenderName = msgColumns.some(col => col.name === 'sender_name');
  if (!hasSenderName) {
    db.prepare("ALTER TABLE messages ADD COLUMN sender_name TEXT NOT NULL DEFAULT ''").run();
    logger.info('Added sender_name column to messages table');
  }

  // 创建 otter_configs 表。
  // #506 注：此表未纳入 schema.ts（历史原因），仅此一处定义——
  // CREATE IF NOT EXISTS 幂等，bootstrap 每次启动都会跑到，老库缺表会被补建。
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

  // F20260819idnw：检查 last_active_turn_number 字段是否存在
  const hasLastActiveTurnNumber = participantColumns.some(col => col.name === 'last_active_turn_number');
  if (!hasLastActiveTurnNumber) {
    db.prepare("ALTER TABLE conversation_participants ADD COLUMN last_active_turn_number INTEGER NOT NULL DEFAULT 0").run();
    logger.info('Added last_active_turn_number column to conversation_participants table');
  }

  /** F20260728htar 一次性补丁 */
  rebuildMessagesFtsStripped(db, logger);
  dropMessagesAttachmentsColumn(db, logger);
  addPinnedColumn(db, logger);

  /** F20260803mval 一次性补丁：移除文档表枚举 CHECK 约束 */
  rebuildDocumentTablesDropCheck(db, logger);

  /** F20260803fbit: features/research 表加 body_hash 列（驱动 upsert 指纹比较） */
  addBodyHashColumns(db, logger);

  /** F20260805rbrg：messages 表添加 metadata 列（招聘桥接查重用） */
  addMessagesMetadataColumn(db, logger);

  /** F20260815rstrt：scheduled_tasks 表添加 restart_before_invoke 列 */
  addRestartBeforeInvokeColumn(db, logger);
  addTimeoutMinutesColumn(db, logger);
  addExecutorTypeColumns(db, logger);

  /** 对话工作区目录：conversations 表添加 workspace_dir 列 */
  addWorkspaceDirColumn(db, logger);

  /** schedule_type + trigger_at 列：支持一次性定时任务 */
  addScheduleTypeColumns(db, logger);

  // F20260827mgux（#506）：原此处的 6 个 ensureXxxTable 誊抄补建（embedding_tasks /
  //  embedding_meta / memory_edges / RHI 两表 / signal_events / restart_pending_resumes）
  // 已删除——bootstrap 无条件跑幂等 initSchema 后老库自动补建，新表只写 schema.ts 一处。
  // 表级等价性由 tests/frameworks/db/migration-equivalence.guard.test.ts 守卫。

  /** F20260813mren Part 2: features/research 表加 created_in_conversation_id 列。*/
  addDocProvenanceColumns(db, logger);

  /** F20260827he2f: healing_events 表添加 introduced_by_pr 列（存量库迁移）。
   *  PR #386 的迁移写在 initSchema 中，存量库永远跑不到——导致 INSERT 时 100% 抛「no such column」。
   *  此处用 PRAGMA table_info 检测列存在性作幂等，与 session_file 等历史补丁列一致。 */
  ensureHealingEventsIntroducedByPrColumn(db, logger);
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

/** F20260805rbrg：messages.metadata TEXT 列存外部 ID 等查重信息。PRAGMA 探测幂等。 */
function addMessagesMetadataColumn(db: Database.Database, logger: Logger): void {
  const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  if (!columns.some(col => col.name === 'metadata')) {
    db.prepare("ALTER TABLE messages ADD COLUMN metadata TEXT").run();
    logger.info('Added metadata column to messages table');
  }

  // 表达式索引：JSON_EXTRACT(metadata, '$.externalId') 查询加速
  // 避免 messages 表增长后 findByExternalId 退化为全表扫描
  const indexes = db.prepare("PRAGMA index_list(messages)").all() as Array<{ name: string }>;
  if (!indexes.some(idx => idx.name === 'idx_messages_external_id')) {
    db.prepare("CREATE INDEX idx_messages_external_id ON messages((JSON_EXTRACT(metadata, '$.externalId')))").run();
    logger.info('Created expression index on messages.metadata.externalId');
  }
}

/** conversations 表添加 workspace_dir 列（对话工作区目录）。PRAGMA 探测幂等。 */
function addWorkspaceDirColumn(db: Database.Database, logger: Logger): void {
  const columns = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
  if (!columns.some(col => col.name === 'workspace_dir')) {
    db.prepare("ALTER TABLE conversations ADD COLUMN workspace_dir TEXT").run();
    logger.info('Added workspace_dir column to conversations table');
  }
}

/** schedule_type + trigger_at 列：支持一次性定时任务。PRAGMA 探测幂等。 */
function addScheduleTypeColumns(db: Database.Database, logger: Logger): void {
  const columns = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as Array<{ name: string }>;
  if (!columns.some(col => col.name === 'schedule_type')) {
    db.prepare("ALTER TABLE scheduled_tasks ADD COLUMN schedule_type TEXT NOT NULL DEFAULT 'cron'").run();
    logger.info('Added schedule_type column to scheduled_tasks table');
  }
  if (!columns.some(col => col.name === 'trigger_at')) {
    db.prepare("ALTER TABLE scheduled_tasks ADD COLUMN trigger_at TEXT").run();
    logger.info('Added trigger_at column to scheduled_tasks table');
  }
}

/**
 * F20260813mren Part 2: features/research 表加 created_in_conversation_id 列。
 * 记录文档由哪段对话产出（事实级 provenance，非推断）。
 * PRAGMA table_info 检测列存在性作幂等。
 */
function addDocProvenanceColumns(db: Database.Database, logger: Logger): void {
  const featuresCols = db.prepare("PRAGMA table_info(features)").all() as Array<{ name: string }>;
  if (!featuresCols.some(col => col.name === 'created_in_conversation_id')) {
    db.prepare("ALTER TABLE features ADD COLUMN created_in_conversation_id TEXT").run();
    logger.info('Added created_in_conversation_id column to features table');
  }

  const researchCols = db.prepare("PRAGMA table_info(research)").all() as Array<{ name: string }>;
  if (!researchCols.some(col => col.name === 'created_in_conversation_id')) {
    db.prepare("ALTER TABLE research ADD COLUMN created_in_conversation_id TEXT").run();
    logger.info('Added created_in_conversation_id column to research table');
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
    // F20260818segs: 优先从 message_segments 聚合 body；降级读 messages.body（旧库）
    const hasSegments = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_segments'").get());
    const insert = db.prepare("INSERT INTO messages_fts (message_id, body) VALUES (?, ?)");
    if (hasSegments) {
      const rows = db.prepare("SELECT message_id, GROUP_CONCAT(body, '\n\n') AS agg FROM message_segments GROUP BY message_id").all() as Array<{ message_id: string; agg: string }>;
      for (const row of rows) {
        insert.run(row.message_id, stripHtmlCardFences(row.agg));
      }
    } else {
      const rows = db.prepare("SELECT id, body FROM messages").all() as Array<{ id: string; body: string | null }>;
      for (const row of rows) {
        insert.run(row.id, row.body === null ? '' : stripHtmlCardFences(row.body));
      }
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

/** F20260815rstrt: scheduled_tasks 表添加 restart_before_invoke 列。PRAGMA 探测幂等。 */
function addRestartBeforeInvokeColumn(db: Database.Database, logger: Logger): void {
  const columns = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as Array<{ name: string }>;
  const hasRestartBeforeInvoke = columns.some(col => col.name === 'restart_before_invoke');
  if (hasRestartBeforeInvoke) return;

  db.prepare("ALTER TABLE scheduled_tasks ADD COLUMN restart_before_invoke INTEGER NOT NULL DEFAULT 0").run();
  logger.info('Added restart_before_invoke column to scheduled_tasks table');
}

/** #516: scheduled_tasks 表添加 timeout_minutes 列（任务级链超时配置）。PRAGMA 探测幂等。 */
function addTimeoutMinutesColumn(db: Database.Database, logger: Logger): void {
  const columns = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as Array<{ name: string }>;
  const hasTimeoutMinutes = columns.some(col => col.name === 'timeout_minutes');
  if (hasTimeoutMinutes) return;

  db.prepare("ALTER TABLE scheduled_tasks ADD COLUMN timeout_minutes INTEGER").run();
  logger.info('Added timeout_minutes column to scheduled_tasks table (#516)');
}

/** PR4: scheduled_tasks 表添加 executor_type + function_name 列（function executor 支持）。PRAGMA 探测幂等。 */
function addExecutorTypeColumns(db: Database.Database, logger: Logger): void {
  const columns = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as Array<{ name: string }>;
  if (!columns.some(col => col.name === 'executor_type')) {
    db.prepare("ALTER TABLE scheduled_tasks ADD COLUMN executor_type TEXT NOT NULL DEFAULT 'agent'").run();
    logger.info('Added executor_type column to scheduled_tasks table');
  }
  if (!columns.some(col => col.name === 'function_name')) {
    db.prepare('ALTER TABLE scheduled_tasks ADD COLUMN function_name TEXT').run();
    logger.info('Added function_name column to scheduled_tasks table');
  }
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
        otterType: otter.type,
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

  // PR审视 B7：不用 syncErrors==0 作 guard——文档 frontmatter 错误是永久性的，
  // 会导致迁移永远不执行（死锁）。sync 成功的文档已有新 chunk；sync 失败的文档
  // 旧 feature_body 删了无妨（下次 sync 成功会生成 chunk）。
  if (syncErrors > 0) {
    logger.warn(`Chunking migration proceeding despite ${syncErrors} sync errors (failed docs will get chunks on next successful sync)`);
  }

  const migrate = db.transaction(() => {
    const types = ["feature_body", "research_body"];
    for (const ct of types) {
      const rows = db.prepare("SELECT id FROM memory_entries WHERE content_type = ?").all(ct) as Array<{ id: string }>;
      for (const row of rows) {
        // 注意（F20260817mrp2 二轮审视）：这里是级联删除卫星表的【第二份实现】（rebuild 迁移路径，
        // 历史 copy）——运行时唯一实现在 sqlite-memory-repository.ts 的 cascadeDeleteSatellites。
        // 新增/修改卫星表时两处都要同步（迁移是一次性补丁，不 import repo 运行时代码）。
        db.prepare("DELETE FROM memory_fts_jieba WHERE memory_entry_id = ?").run(row.id);
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

/**
 * F20260827he2f: healing_events 表添加 introduced_by_pr 列（存量库迁移）。
 * PR #386 的迁移写在 initSchema 中，存量库永远跑不到——导致 INSERT 时 100% 抛「no such column」。
 * 此处用 PRAGMA table_info 检测列存在性作幂等，与 session_file 等历史补丁列一致。
 */
function ensureHealingEventsIntroducedByPrColumn(db: Database.Database, logger: Logger): void {
  const columns = db.prepare("PRAGMA table_info(healing_events)").all() as Array<{ name: string }>;
  const hasIntroducedByPr = columns.some(col => col.name === 'introduced_by_pr');
  if (!hasIntroducedByPr) {
    db.prepare("ALTER TABLE healing_events ADD COLUMN introduced_by_pr TEXT").run();
    logger.info('Added introduced_by_pr column to healing_events table');
  }
}

/**
 * F20260818segs: message_segments 子表迁移。
 * （#506 后建表职责由 initSchema 无条件承担，此函数只做存量数据搬移与 body 列移除：
 *  1. 将存量 messages.body 迁移到 message_segments（一条 body → 一个 segment，sequence_num=0）
 *  2. 移除 messages.body 列（SQLite 3.35+ DROP COLUMN，降级时跳过））
 */
export function migrateMessageSegments(db: Database.Database, logger: Logger): void {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'message_segments_migrated'").get() as { value: string } | undefined;
  if (done?.value === 'done') return;

  const migrate = db.transaction(() => {
    // 1. 建表职责已移交 initSchema（#506），此处不重复 CREATE

    // 2. 存量迁移：messages.body → message_segments
    const hasBody = (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).some(c => c.name === 'body');
    if (hasBody) {
      // 空/NULL body 不迁移（streaming 消息无内容），有内容的 body 迁移为 segment
      const rows = db.prepare("SELECT id, body, created_at FROM messages WHERE body IS NOT NULL AND body != ''").all() as Array<{ id: string; body: string; created_at: string }>;
      const insert = db.prepare("INSERT OR IGNORE INTO message_segments (id, message_id, body, sequence_num, created_at) VALUES (?, ?, ?, 0, ?)");
      for (const row of rows) {
        insert.run(`seg-${row.id}`, row.id, row.body, row.created_at);
      }
      logger.info(`Migrated ${rows.length} message bodies to message_segments`);
    }

    // 3. 标记迁移完成（在 DROP COLUMN 之前，避免 DROP 失败导致 livelock）
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('message_segments_migrated', 'done', datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = 'done', updated_at = datetime('now')",
    ).run();

    // 4. 移除 messages.body 列（SQLite 3.35+，降级时跳过——列保留但不再使用）
    if (hasBody) {
      try {
        db.exec("ALTER TABLE messages DROP COLUMN body");
        logger.info('Dropped messages.body column');
      } catch (e) {
        logger.warn(`Could not drop messages.body column (SQLite version may not support DROP COLUMN): ${e}`);
      }
    }
  });
  migrate();
  logger.info('Message segments migration completed (message_segments_migrated=done)');
}
