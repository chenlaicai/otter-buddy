import type Database from 'better-sqlite3';
import type { SignalEvent, SignalQueryFilter } from '@entities/signal/signal-event';
import type { SignalEventRepository } from '@usecases/signal/signal-event-repository';
import { rowToSignalEvent, signalEventToInsertValues, buildSignalFilterClause, type SignalEventRow } from './signal-event-mapper';

/**
 * Signal events 的 SQLite 实现（F20260826mwrd C1）。
 * 表结构在 schema.ts createSignalsTable 创建（幂等 CREATE IF NOT EXISTS）。
 */
export class SqliteSignalEventRepository implements SignalEventRepository {
  constructor(private readonly db: Database.Database) {}

  async create(event: SignalEvent): Promise<void> {
    const values = signalEventToInsertValues(event);
    this.db.prepare(`
      INSERT INTO signal_events (
        id, conversation_id, message_id, from_otter_id, target_otter_id,
        type, severity, payload, status, resolution, resolved_by, resolved_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...values);
  }

  async findById(id: string): Promise<SignalEvent | null> {
    const row = this.db.prepare(
      'SELECT * FROM signal_events WHERE id = ?',
    ).get(id) as SignalEventRow | undefined;
    return row ? rowToSignalEvent(row) : null;
  }

  async findByConversation(conversationId: string, filter?: SignalQueryFilter, limit = 50): Promise<SignalEvent[]> {
    const { clause, params } = buildSignalFilterClause(filter);
    const rows = this.db.prepare(
      `SELECT * FROM signal_events WHERE conversation_id = ?${clause} ORDER BY created_at DESC LIMIT ?`,
    ).all(conversationId, ...params, limit) as SignalEventRow[];
    return rows.map(rowToSignalEvent);
  }

  async resolve(id: string, status: 'resolved' | 'dismissed', resolution: string, resolvedBy: string): Promise<SignalEvent | null> {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      "UPDATE signal_events SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'",
    ).run(status, resolution, resolvedBy, now, id);
    if (result.changes === 0) {
      // 区分「不存在」与「已裁决」（幂等防重）：读回确认
      const row = await this.findById(id);
      return row && row.status !== 'pending' ? row : null;
    }
    return this.findById(id);
  }
}
