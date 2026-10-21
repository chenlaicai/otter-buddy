import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db';
import { SqliteScheduledTaskPendingItemRepository } from '@frameworks/db/scheduled-task/sqlite-pending-item-repository';
import { ManageScheduledTaskPending } from '@usecases/scheduler/manage-scheduled-task-pending';
import { createManageScheduledTaskPendingTool } from '@interface-adapters/agent-runtime/tools/scheduled-task-pending-tools';
import type { ToolContext } from '@usecases/ports/agent-tools';

const SLOT = '2026-10-21T01:00:00.000Z';

function seed(db: Database.Database) {
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 't', ?, ?)`).run(SLOT, SLOT);
  db.prepare(`INSERT INTO scheduled_tasks (
    id, conversation_id, name, schedule_type, cron, timezone, body, description,
    executor_role, talking_stone_passed_to, sender_id, status,
    consecutive_failures, restart_before_invoke, executor_type, created_at, updated_at
  ) VALUES ('task-1', 'conv-1', '日报', 'cron', '0 9 * * *', 'Asia/Shanghai', '完整任务正文', '任务描述',
    '大獭', '[]', 'system', 'active', 0, 0, 'agent', ?, ?)`).run(SLOT, SLOT);
}

function text(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text;
}

describe('manage_scheduled_task_pending', () => {
  let db: Database.Database;
  let repo: SqliteScheduledTaskPendingItemRepository;
  let tool: ReturnType<typeof createManageScheduledTaskPendingTool>;
  beforeEach(() => {
    db = createTestDb();
    seed(db);
    repo = new SqliteScheduledTaskPendingItemRepository(db);
    const manage = new ManageScheduledTaskPending(repo, {
      getById: async () => ({ body: '完整任务正文', description: '任务描述' }),
    } as never);
    const ctx = {
      conversationId: 'conv-1', otterId: 'big-1', currentMessageId: 'm-1',
      client: { otter: { getById: async () => ({ name: '大獭' }) } },
    } as unknown as ToolContext;
    tool = createManageScheduledTaskPendingTool(ctx, manage);
    void repo.enqueue({
      id: 'p-1', taskId: 'task-1', conversationId: 'conv-1', role: '大獭', triggeredAt: SLOT,
      status: 'pending', consumedAt: null, resolution: null, resolutionReason: null,
    });
  });
  afterEach(() => db.close());

  it('list 不泄露正文，detail 拉全文，ack 必填 resolution+reason 且幂等', async () => {
    const listed = JSON.parse(text(await tool.execute('t1', { action: 'list' })));
    expect(listed[0]).toMatchObject({ pendingId: 'p-1', taskName: '日报' });
    expect(JSON.stringify(listed)).not.toContain('完整任务正文');
    expect(text(await tool.execute('t2', { action: 'ack', pendingId: 'p-1', resolution: 'skipped' }))).toContain('reason');

    const detail = JSON.parse(text(await tool.execute('t3', { action: 'detail', pendingId: 'p-1' })));
    expect(detail).toMatchObject({ kind: 'detail', body: '完整任务正文', description: '任务描述' });
    const acked = JSON.parse(text(await tool.execute('t4', {
      action: 'ack', pendingId: 'p-1', resolution: 'executed', reason: '已补发日报',
    })));
    expect(acked.kind).toBe('acked');
    expect(await repo.list('conv-1', '大獭')).toEqual([]);
    expect(text(await tool.execute('t5', { action: 'ack', pendingId: 'p-1', resolution: 'executed', reason: '重复' }))).toContain('已销账');
  });

  it('detail/ack 前重查直发 completed（message_id 非空），覆盖双跑残留缝', async () => {
    db.prepare(`INSERT INTO scheduled_task_executions (
      id, task_id, triggered_at, completed_at, status, message_id
    ) VALUES ('direct-exec', 'task-1', ?, ?, 'completed', 'anchor')`).run(SLOT, SLOT);
    const detail = JSON.parse(text(await tool.execute('t1', { action: 'detail', pendingId: 'p-1' })));
    expect(detail.covered).toBe(true);
    const ack = JSON.parse(text(await tool.execute('t2', {
      action: 'ack', pendingId: 'p-1', resolution: 'skipped', reason: '已直发',
    })));
    expect(ack.kind).toBe('covered');
  });
});
