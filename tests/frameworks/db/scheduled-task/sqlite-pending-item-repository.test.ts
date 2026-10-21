import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../helpers/db';
import { SqliteScheduledTaskPendingItemRepository } from '@frameworks/db/scheduled-task/sqlite-pending-item-repository';

const SLOT = '2026-10-21T01:00:00.000Z';

function seedTask(db: Database.Database, id = 'task-1', conversationId = 'conv-1') {
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 't', ?, ?)`)
    .run(conversationId, SLOT, SLOT);
  db.prepare(`INSERT INTO scheduled_tasks (
    id, conversation_id, name, schedule_type, cron, timezone, body,
    executor_role, talking_stone_passed_to, sender_id, status,
    consecutive_failures, restart_before_invoke, executor_type, created_at, updated_at
  ) VALUES (?, ?, '日报', 'cron', '0 9 * * *', 'Asia/Shanghai', '任务全文', '大獭', '[]', 'system', 'active', 0, 0, 'agent', ?, ?)`)
    .run(id, conversationId, SLOT, SLOT);
}

function pending(id: string, taskId = 'task-1') {
  return {
    id, taskId, conversationId: 'conv-1', role: '大獭', triggeredAt: SLOT,
    status: 'pending' as const, consumedAt: null, resolution: null, resolutionReason: null,
  };
}

describe('SqliteScheduledTaskPendingItemRepository', () => {
  let db: Database.Database;
  let repo: SqliteScheduledTaskPendingItemRepository;
  beforeEach(() => {
    db = createTestDb();
    seedTask(db);
    repo = new SqliteScheduledTaskPendingItemRepository(db);
  });
  afterEach(() => db.close());

  it('同任务 pending 由部分唯一索引去重，ack 后允许新 pending', async () => {
    expect(await repo.enqueue(pending('p-1'))).toBe(true);
    expect(await repo.enqueue(pending('p-2'))).toBe(false);
    expect(await repo.list('conv-1', '大獭')).toHaveLength(1);
    expect(await repo.consume({
      id: 'p-1', conversationId: 'conv-1', role: '大獭', resolution: 'skipped',
      reason: '已手动处理', consumedAt: SLOT,
    })).toBe(true);
    expect(await repo.consume({
      id: 'p-1', conversationId: 'conv-1', role: '大獭', resolution: 'skipped',
      reason: '重复 ack', consumedAt: SLOT,
    })).toBe(false);
    expect(await repo.enqueue(pending('p-3'))).toBe(true);
  });

  it('角色精确过滤，detail 不跨对话/角色读取', async () => {
    await repo.enqueue(pending('p-1'));
    expect(await repo.list('conv-1', '巡检獭')).toEqual([]);
    expect(await repo.getById('p-1', 'other-conv')).toBeNull();
    expect(await repo.getById('p-1', 'conv-1')).toMatchObject({ taskName: '日报', role: '大獭' });
  });

  it('同槽位对账排除 pending 自身 completed；真直发锚点才算已覆盖', async () => {
    db.prepare(`INSERT INTO scheduled_task_executions (
      id, task_id, triggered_at, completed_at, status, message_id
    ) VALUES ('pending-exec', 'task-1', ?, ?, 'completed', NULL)`).run(SLOT, SLOT);
    expect(await repo.hasDirectCompletionInSlot('task-1', SLOT)).toBe(false);
    expect(await repo.hasExecutionInSlot('task-1', SLOT, ['completed'], 'pending-exec')).toBe(false);

    db.prepare(`INSERT INTO scheduled_task_executions (
      id, task_id, triggered_at, completed_at, status, message_id
    ) VALUES ('direct-exec', 'task-1', ?, ?, 'completed', 'anchor-entry')`).run(SLOT, SLOT);
    expect(await repo.hasDirectCompletionInSlot('task-1', SLOT)).toBe(true);
  });
});
