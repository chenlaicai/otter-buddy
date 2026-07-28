/**
 * 数据库迁移：Session 复用机制
 */

import type Database from "better-sqlite3";
import type { Logger } from "@usecases/ports/logger";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";
import { stripHtmlCardFences } from "@entities/conversation/message-body-projection";

/** 数据库迁移：添加 session_file 字段和 otter_configs 表 */
export function migrateDatabase(db: Database.Database, logger: Logger): void {
  // 检查 session_file 字段是否存在
  const columns = db.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>;
  const hasSessionFile = columns.some(col => col.name === 'session_file');

  if (!hasSessionFile) {
    db.prepare("ALTER TABLE agent_sessions ADD COLUMN session_file TEXT NOT NULL DEFAULT ''").run();
    logger.info('Added session_file column to agent_sessions table');
  }

  // 创建 otter_configs 表
  db.prepare(`
    CREATE TABLE IF NOT EXISTS otter_configs (
      otter_id TEXT PRIMARY KEY,
      system_prompt TEXT,
      otter_type TEXT NOT NULL DEFAULT 'big' CHECK(otter_type IN ('big', 'small')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  logger.info('Ensured otter_configs table exists');

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
