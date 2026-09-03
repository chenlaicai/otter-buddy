import type Database from 'better-sqlite3';
import type { HealingEvent, HealingEventStats, HealingEventStatus, HealingResolution } from '@entities/healing/healing-event';
import type { HealingEventRepository, HealingEventBatchFilter, BatchResolveResult } from '@usecases/healing/healing-event-repository';
import { rowToHealingEvent, eventToRow, type HealingEventRow } from './healing-event-mapper';

export class SqliteHealingEventRepository implements HealingEventRepository {
  constructor(private readonly db: Database.Database) {}

  async create(event: HealingEvent): Promise<void> {
    const row = eventToRow(event);
    this.db.prepare(`
      INSERT INTO healing_events (
        id, message_id, conversation_id, otter_id, error_type, severity,
        description, suggestion, context, status, resolution, created_at, resolved_at, introduced_by_pr
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.message_id, row.conversation_id, row.otter_id,
      row.error_type, row.severity, row.description, row.suggestion,
      row.context, row.status, row.resolution, row.created_at, row.resolved_at,
      row.introduced_by_pr,
    );
  }

  async findById(id: string): Promise<HealingEvent | null> {
    const row = this.db.prepare(
      'SELECT * FROM healing_events WHERE id = ?',
    ).get(id) as HealingEventRow | undefined;
    return row ? rowToHealingEvent(row) : null;
  }

  async findOpen(limit = 50): Promise<HealingEvent[]> {
    const rows = this.db.prepare(
      'SELECT * FROM healing_events WHERE status = ? ORDER BY created_at DESC LIMIT ?',
    ).all('open', limit) as HealingEventRow[];
    return rows.map(rowToHealingEvent);
  }

  async findAll(status: HealingEventStatus, limit = 50): Promise<HealingEvent[]> {
    const rows = this.db.prepare(
      'SELECT * FROM healing_events WHERE status = ? ORDER BY created_at DESC LIMIT ?',
    ).all(status, limit) as HealingEventRow[];
    return rows.map(rowToHealingEvent);
  }

  async findByConversation(conversationId: string, errorType?: string): Promise<HealingEvent[]> {
    // F20260903ah68 S3.5（mimo 审视焦点4）：可选 errorType 过滤——GateBanner 2s 轮询
    // 只消费 rate_limit 事件，过滤下推 SQL + idx_healing_events_conversation 索引命中
    const rows = errorType
      ? this.db.prepare(
          'SELECT * FROM healing_events WHERE conversation_id = ? AND error_type = ? ORDER BY created_at DESC',
        ).all(conversationId, errorType) as HealingEventRow[]
      : this.db.prepare(
          'SELECT * FROM healing_events WHERE conversation_id = ? ORDER BY created_at DESC',
        ).all(conversationId) as HealingEventRow[];
    return rows.map(rowToHealingEvent);
  }

  async findRecentByOtter(otterId: string, errorType: string, limit = 10): Promise<HealingEvent[]> {
    const rows = this.db.prepare(
      'SELECT * FROM healing_events WHERE otter_id = ? AND error_type = ? ORDER BY created_at DESC LIMIT ?',
    ).all(otterId, errorType, limit) as HealingEventRow[];
    return rows.map(rowToHealingEvent);
  }

  async updateStatus(id: string, status: HealingEventStatus): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE healing_events SET status = ?, resolved_at = ? WHERE id = ?',
    ).run(status, status === 'resolved' || status === 'dismissed' ? now : null, id);
  }

  async resolve(id: string, resolution: HealingResolution): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE healing_events SET status = ?, resolution = ?, resolved_at = ? WHERE id = ?',
    ).run('resolved', JSON.stringify(resolution), now, id);
  }

  async getStats(): Promise<HealingEventStats> {
    const statusRows = this.db.prepare(
      'SELECT status, COUNT(*) as cnt FROM healing_events GROUP BY status',
    ).all() as Array<{ status: string; cnt: number }>;

    const typeRows = this.db.prepare(
      "SELECT error_type, COUNT(*) as cnt FROM healing_events WHERE status = 'open' GROUP BY error_type",
    ).all() as Array<{ error_type: string; cnt: number }>;

    const severityRows = this.db.prepare(
      "SELECT severity, COUNT(*) as cnt FROM healing_events WHERE status = 'open' GROUP BY severity",
    ).all() as Array<{ severity: string; cnt: number }>;

    const stats: HealingEventStats = { open: 0, resolved: 0, dismissed: 0, byType: {}, bySeverity: {} };
    for (const row of statusRows) {
      if (row.status === 'open') stats.open = row.cnt;
      else if (row.status === 'resolved') stats.resolved = row.cnt;
      else if (row.status === 'dismissed') stats.dismissed = row.cnt;
    }
    for (const row of typeRows) stats.byType[row.error_type] = row.cnt;
    for (const row of severityRows) stats.bySeverity[row.severity] = row.cnt;

    return stats;
  }

  async autoStaleDismiss(staleDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE healing_events SET status = 'dismissed', resolved_at = ?
      WHERE status = 'open' AND created_at < ?
    `).run(now, cutoff);
    return result.changes;
  }

  async batchResolveByFilter(
    filter: HealingEventBatchFilter,
    resolution: HealingResolution,
    options?: { limit?: number; dryRun?: boolean },
  ): Promise<BatchResolveResult> {
    const limit = options?.limit ?? 100;
    const dryRun = options?.dryRun ?? false;

    // Why: 动态构建 WHERE 子句——filter 全字段可选，AND 拼接
    const clauses: string[] = [];
    const params: unknown[] = [];

    const status = filter.status ?? 'open';
    clauses.push('status = ?');
    params.push(status);

    if (filter.errorType) {
      clauses.push('error_type = ?');
      params.push(filter.errorType);
    }
    if (filter.createdBefore) {
      clauses.push('created_at < ?');
      params.push(filter.createdBefore);
    }
    if (filter.createdAfter) {
      clauses.push('created_at > ?');
      params.push(filter.createdAfter);
    }

    const where = clauses.join(' AND ');

    // dryRun: 只返回匹配数
    if (dryRun) {
      const countRow = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM healing_events WHERE ${where}`,
      ).get(...params) as { cnt: number };
      return { matched: countRow.cnt, resolved: 0, resolvedIds: [] };
    }

    // Why: 单事务保证 count + match + update 原子性
    const now = new Date().toISOString();
    const resolutionJson = JSON.stringify(resolution);
    const result = this.db.transaction(() => {
      const totalRow = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM healing_events WHERE ${where}`,
      ).get(...params) as { cnt: number };

      const matchedRows = this.db.prepare(
        `SELECT id FROM healing_events WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
      ).all(...params, limit) as Array<{ id: string }>;

      if (matchedRows.length === 0) return { matched: 0, resolved: 0, resolvedIds: [], truncated: false, totalMatched: totalRow.cnt };

      const ids = matchedRows.map(r => r.id);
      const placeholders = ids.map(() => '?').join(', ');
      const updateResult = this.db.prepare(
        `UPDATE healing_events SET status = 'resolved', resolution = ?, resolved_at = ? WHERE id IN (${placeholders})`,
      ).run(resolutionJson, now, ...ids);

      return {
        matched: ids.length,
        resolved: updateResult.changes,
        resolvedIds: ids,
        // Why: truncated 让调用方知道还有剩余未处置（100 上限截断）
        truncated: totalRow.cnt > ids.length,
        totalMatched: totalRow.cnt,
      };
    })();

    return result;
  }
}
