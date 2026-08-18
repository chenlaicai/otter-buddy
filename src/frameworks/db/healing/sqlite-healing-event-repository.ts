import type Database from 'better-sqlite3';
import type { HealingEvent, HealingEventStats, HealingEventStatus, HealingResolution } from '@entities/healing/healing-event';
import type { HealingEventRepository } from '@usecases/healing/healing-event-repository';
import { rowToHealingEvent, eventToRow, type HealingEventRow } from './healing-event-mapper';

export class SqliteHealingEventRepository implements HealingEventRepository {
  constructor(private readonly db: Database.Database) {}

  async create(event: HealingEvent): Promise<void> {
    const row = eventToRow(event);
    this.db.prepare(`
      INSERT INTO healing_events (
        id, message_id, conversation_id, otter_id, error_type, severity,
        description, suggestion, context, status, resolution, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.message_id, row.conversation_id, row.otter_id,
      row.error_type, row.severity, row.description, row.suggestion,
      row.context, row.status, row.resolution, row.created_at, row.resolved_at,
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

  async findByConversation(conversationId: string): Promise<HealingEvent[]> {
    const rows = this.db.prepare(
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
}
