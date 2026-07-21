import type Database from 'better-sqlite3';
import type {
  ScheduledTask,
  ScheduledTaskExecution,
  ScheduledTaskStatus,
  ExecutionStatus,
} from '@entities/scheduled-task/scheduled-task';
import type {
  ScheduledTaskRepository,
  ListExecutionsOptions,
} from '@usecases/scheduled-task/scheduled-task-repository';
import {
  rowToScheduledTask,
  rowToExecution,
  taskToRow,
  type ScheduledTaskRow,
  type ScheduledTaskExecutionRow,
} from './scheduled-task-mapper';

export class SqliteScheduledTaskRepository implements ScheduledTaskRepository {
  constructor(private readonly db: Database.Database) {}

  async create(task: ScheduledTask): Promise<void> {
    const row = taskToRow(task);
    this.db.prepare(`
      INSERT INTO scheduled_tasks (
        id, conversation_id, name, cron, timezone, body,
        talking_stone_passed_to, sender_id, status, consecutive_failures,
        last_triggered_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.conversation_id, row.name, row.cron, row.timezone,
      row.body, row.talking_stone_passed_to, row.sender_id, row.status,
      row.consecutive_failures, row.last_triggered_at, row.created_at,
      row.updated_at,
    );
  }

  async getById(id: string): Promise<ScheduledTask | null> {
    const row = this.db.prepare(
      'SELECT * FROM scheduled_tasks WHERE id = ?',
    ).get(id) as ScheduledTaskRow | undefined;
    return row ? rowToScheduledTask(row) : null;
  }

  async getByConversationId(conversationId: string): Promise<ScheduledTask[]> {
    const rows = this.db.prepare(
      'SELECT * FROM scheduled_tasks WHERE conversation_id = ? ORDER BY created_at DESC',
    ).all(conversationId) as ScheduledTaskRow[];
    return rows.map(rowToScheduledTask);
  }

  async getAllActive(): Promise<ScheduledTask[]> {
    const rows = this.db.prepare(
      "SELECT * FROM scheduled_tasks WHERE status = 'active' ORDER BY created_at DESC",
    ).all() as ScheduledTaskRow[];
    return rows.map(rowToScheduledTask);
  }

  async update(task: ScheduledTask): Promise<void> {
    const row = taskToRow(task);
    this.db.prepare(`
      UPDATE scheduled_tasks SET
        name = ?, cron = ?, timezone = ?, body = ?,
        talking_stone_passed_to = ?, sender_id = ?, status = ?,
        consecutive_failures = ?, last_triggered_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      row.name, row.cron, row.timezone, row.body,
      row.talking_stone_passed_to, row.sender_id, row.status,
      row.consecutive_failures, row.last_triggered_at, row.updated_at,
      row.id,
    );
  }

  async updateStatus(id: string, status: ScheduledTaskStatus, updatedAt: string): Promise<void> {
    this.db.prepare(
      'UPDATE scheduled_tasks SET status = ?, updated_at = ? WHERE id = ?',
    ).run(status, updatedAt, id);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  }

  async incrementConsecutiveFailures(id: string, updatedAt: string): Promise<number> {
    this.db.prepare(`
      UPDATE scheduled_tasks
      SET consecutive_failures = consecutive_failures + 1, updated_at = ?
      WHERE id = ?
    `).run(updatedAt, id);

    const row = this.db.prepare(
      'SELECT consecutive_failures FROM scheduled_tasks WHERE id = ?',
    ).get(id) as { consecutive_failures: number } | undefined;
    return row?.consecutive_failures ?? 0;
  }

  async resetConsecutiveFailures(id: string, updatedAt: string): Promise<void> {
    this.db.prepare(
      'UPDATE scheduled_tasks SET consecutive_failures = 0, updated_at = ? WHERE id = ?',
    ).run(updatedAt, id);
  }

  async claimTask(id: string, lastTriggeredAt: string, updatedAt: string): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE scheduled_tasks
      SET last_triggered_at = ?, updated_at = ?
      WHERE id = ?
        AND status = 'active'
        AND (last_triggered_at IS NULL OR datetime(last_triggered_at) < datetime(?, '-60 seconds'))
    `).run(lastTriggeredAt, updatedAt, id, lastTriggeredAt);
    return result.changes > 0;
  }

  async createExecution(execution: ScheduledTaskExecution): Promise<void> {
    this.db.prepare(`
      INSERT INTO scheduled_task_executions (
        id, task_id, triggered_at, completed_at, status,
        error_message, message_id, turn_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      execution.id, execution.taskId, execution.triggeredAt,
      execution.completedAt, execution.status, execution.errorMessage,
      execution.messageId, execution.turnId,
    );
  }

  async updateExecutionStatus(
    id: string,
    updates: {
      status: ExecutionStatus;
      completedAt?: string;
      errorMessage?: string;
      messageId?: string;
      turnId?: string;
    },
  ): Promise<void> {
    this.db.prepare(`
      UPDATE scheduled_task_executions SET
        status = ?, completed_at = ?, error_message = ?,
        message_id = ?, turn_id = ?
      WHERE id = ?
    `).run(
      updates.status,
      updates.completedAt ?? null,
      updates.errorMessage ?? null,
      updates.messageId ?? null,
      updates.turnId ?? null,
      id,
    );
  }

  async getExecutions(
    taskId: string,
    options?: ListExecutionsOptions,
  ): Promise<ScheduledTaskExecution[]> {
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;
    const rows = this.db.prepare(`
      SELECT * FROM scheduled_task_executions
      WHERE task_id = ?
      ORDER BY triggered_at DESC
      LIMIT ? OFFSET ?
    `).all(taskId, limit, offset) as ScheduledTaskExecutionRow[];
    return rows.map(rowToExecution);
  }

  async getExecutionCount(taskId: string): Promise<number> {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM scheduled_task_executions WHERE task_id = ?',
    ).get(taskId) as { count: number };
    return row.count;
  }
}
