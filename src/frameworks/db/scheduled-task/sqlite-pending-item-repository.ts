import type Database from 'better-sqlite3';
import type {
  ExecutionStatus,
  ScheduledTaskPendingItem,
  ScheduledTaskPendingResolution,
} from '@entities/scheduled-task/scheduled-task';
import type {
  ScheduledTaskPendingItemRepository,
  ScheduledTaskPendingListItem,
} from '@usecases/scheduler/pending-item-repository';

interface PendingItemRow {
  id: string;
  task_id: string;
  conversation_id: string;
  role: string;
  triggered_at: string;
  status: 'pending' | 'consumed';
  consumed_at: string | null;
  resolution: ScheduledTaskPendingResolution | null;
  resolution_reason: string | null;
  task_name: string;
}

function rowToPendingItem(row: PendingItemRow): ScheduledTaskPendingListItem {
  return {
    id: row.id,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    role: row.role,
    triggeredAt: row.triggered_at,
    status: row.status,
    consumedAt: row.consumed_at,
    resolution: row.resolution,
    resolutionReason: row.resolution_reason,
    taskName: row.task_name,
  };
}

export class SqliteScheduledTaskPendingItemRepository implements ScheduledTaskPendingItemRepository {
  constructor(private readonly db: Database.Database) {}

  async enqueue(item: ScheduledTaskPendingItem): Promise<boolean> {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO scheduled_task_pending_items (
        id, task_id, conversation_id, role, triggered_at, status,
        consumed_at, resolution, resolution_reason
      ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)
    `).run(item.id, item.taskId, item.conversationId, item.role, item.triggeredAt);
    return result.changes === 1;
  }

  async list(conversationId: string, role?: string): Promise<ScheduledTaskPendingListItem[]> {
    const rows = this.db.prepare(`
      SELECT p.*, t.name AS task_name
      FROM scheduled_task_pending_items p
      JOIN scheduled_tasks t ON t.id = p.task_id
      WHERE p.conversation_id = ? AND p.status = 'pending' AND (? IS NULL OR p.role = ?)
      ORDER BY p.triggered_at ASC, p.id ASC
    `).all(conversationId, role ?? null, role ?? null) as PendingItemRow[];
    return rows.map(rowToPendingItem);
  }

  async getById(id: string, conversationId: string): Promise<ScheduledTaskPendingListItem | null> {
    const row = this.db.prepare(`
      SELECT p.*, t.name AS task_name
      FROM scheduled_task_pending_items p
      JOIN scheduled_tasks t ON t.id = p.task_id
      WHERE p.id = ? AND p.conversation_id = ? AND p.status = 'pending'
    `).get(id, conversationId) as PendingItemRow | undefined;
    return row ? rowToPendingItem(row) : null;
  }

  async hasExecutionInSlot(taskId: string, triggeredAt: string, statuses: ExecutionStatus[], excludeExecutionId?: string): Promise<boolean> {
    if (statuses.length === 0) return false;
    const placeholders = statuses.map(() => '?').join(', ');
    const row = this.db.prepare(`
      SELECT 1 AS present FROM scheduled_task_executions
      WHERE task_id = ? AND triggered_at = ? AND status IN (${placeholders})
        AND (? IS NULL OR id != ?)
      LIMIT 1
    `).get(taskId, triggeredAt, ...statuses, excludeExecutionId ?? null, excludeExecutionId ?? null) as { present: number } | undefined;
    return row?.present === 1;
  }

  async hasDirectCompletionInSlot(taskId: string, triggeredAt: string): Promise<boolean> {
    const row = this.db.prepare(`
      SELECT 1 AS present FROM scheduled_task_executions
      WHERE task_id = ? AND triggered_at = ? AND status = 'completed' AND message_id IS NOT NULL
      LIMIT 1
    `).get(taskId, triggeredAt) as { present: number } | undefined;
    return row?.present === 1;
  }

  async consume(input: {
    id: string;
    conversationId: string;
    role: string;
    resolution: ScheduledTaskPendingResolution;
    reason: string;
    consumedAt: string;
  }): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE scheduled_task_pending_items
      SET status = 'consumed', consumed_at = ?, resolution = ?, resolution_reason = ?
      WHERE id = ? AND conversation_id = ? AND role = ? AND status = 'pending'
    `).run(input.consumedAt, input.resolution, input.reason, input.id, input.conversationId, input.role);
    return result.changes === 1;
  }
}
