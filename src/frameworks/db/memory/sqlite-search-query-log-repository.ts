/**
 * SqliteSearchQueryLogRepository：检索埋点写入实现。
 *
 * 表结构见 schema.ts search_query_logs。
 */

import type Database from "better-sqlite3";
import type {
  SearchQueryLogInsert,
  SearchQueryContextMessage,
} from "@entities/memory/search-query-log";
import type { SearchQueryLogRepository } from "@usecases/memory/search-query-log-repository";

export class SqliteSearchQueryLogRepository implements SearchQueryLogRepository {
  constructor(private readonly db: Database.Database) {}

  async insert(log: SearchQueryLogInsert): Promise<void> {
    this.db.prepare(`
      INSERT INTO search_query_logs (
        id, query, query_hash, query_length, log_mode, conversation_id, caller_id,
        detail_level, library, limit_count,
        top_entry_ids, total, context_messages, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      log.query,
      log.queryHash,
      log.queryLength,
      log.logMode,
      log.conversationId,
      log.callerId,
      log.detailLevel ?? null,
      log.library ?? null,
      log.limitCount ?? null,
      JSON.stringify(log.topEntryIds),
      log.total,
      JSON.stringify(log.contextMessages satisfies SearchQueryContextMessage[]),
      new Date().toISOString(),
    );
  }

  async deleteByConversation(conversationId: string): Promise<number> {
    return this.db.prepare(
      "DELETE FROM search_query_logs WHERE conversation_id = ?",
    ).run(conversationId).changes;
  }

  async deleteRedactedOlderThan(cutoffIso: string): Promise<number> {
    return this.db.prepare(
      "DELETE FROM search_query_logs WHERE log_mode = 'redacted' AND created_at < ?",
    ).run(cutoffIso).changes;
  }
}
