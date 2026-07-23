/**
 * 数据库迁移：Session 复用机制
 */

import type Database from "better-sqlite3";
import type { Logger } from "@usecases/ports/logger";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";

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

  // 检查 last_read_sequence_num 字段是否存在
  const participantColumns = db.prepare("PRAGMA table_info(conversation_participants)").all() as Array<{ name: string }>;
  const hasLastRead = participantColumns.some(col => col.name === 'last_read_sequence_num');

  if (!hasLastRead) {
    db.prepare("ALTER TABLE conversation_participants ADD COLUMN last_read_sequence_num INTEGER NOT NULL DEFAULT 0").run();
    logger.info('Added last_read_sequence_num column to conversation_participants table');
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
        otterType: otter.type as 'big' | 'small',
        // systemPrompt 为 undefined，因为当前代码存储在内存 Map 中，无法迁移
      });
    }
  }

  logger.warn('Migration completed. IMPORTANT: All old sessions will be recreated on first invoke. Previous session context and system prompts will be lost. You need to reconfigure system prompts after migration.');
}
