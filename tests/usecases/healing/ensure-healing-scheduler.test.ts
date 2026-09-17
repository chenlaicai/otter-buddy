import { describe, it, expect, vi } from 'vitest';
import { ensureHealingScheduler } from '@usecases/healing/ensure-healing-scheduler';
import type { ScheduledTask } from '@entities/scheduled-task/scheduled-task';

// ─── #1004 检视发现 1：regression-verify seed 不受 healing early return 阻断 ──────
// 存量系统中 self-healing-analysis 必然已 active——若 regression-verify 的 seed 在
// healing 的 early return 之后，新任务永远不会被创建。本测试锁死两个任务的独立 seed 语义。

function makeTask(name: string, status: 'active' | 'disabled' = 'active'): ScheduledTask {
  return {
    id: `task-${name}`,
    conversationId: 'conv-heal',
    name,
    scheduleType: 'cron',
    cron: '0 10 * * *',
    triggerAt: null,
    timezone: 'Asia/Shanghai',
    body: `[${name}]`,
    description: null,
    talkingStonePassedTo: ['otter-big'],
    senderId: 'system',
    status,
    timeoutMinutes: 15,
    restartBeforeInvoke: false,
    lastTriggeredAt: null,
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
  } as ScheduledTask;
}

function makeDeps(existingTasks: ScheduledTask[]) {
  const created: string[] = [];
  return {
    created,
    deps: {
      manageScheduledTask: {
        create: vi.fn(async (input: { name: string }) => { created.push(input.name); }),
      },
      scheduledTaskRepo: {
        getByConversationId: vi.fn(async () => existingTasks),
      },
      healingConversationId: 'conv-heal',
      bigOtterId: 'otter-big',
    },
  };
}

describe('ensureHealingScheduler（#1004 seed 独立性）', () => {
  it('存量系统：healing 已 active 时，regression-verify 仍被 seed（不被 early return 阻断）', async () => {
    const { deps, created } = makeDeps([makeTask('self-healing-analysis')]);
    await ensureHealingScheduler(deps as never);
    expect(created).toEqual(['regression-verify']);
  });

  it('全新系统：两个任务都不存在时，两者都被 seed', async () => {
    const { deps, created } = makeDeps([]);
    await ensureHealingScheduler(deps as never);
    expect(created).toContain('self-healing-analysis');
    expect(created).toContain('regression-verify');
    expect(created).toHaveLength(2);
  });

  it('两任务都已 active 时幂等：什么都不创建', async () => {
    const { deps, created } = makeDeps([makeTask('self-healing-analysis'), makeTask('regression-verify')]);
    await ensureHealingScheduler(deps as never);
    expect(created).toHaveLength(0);
  });

  it('regression-verify 被 disabled 时重新 seed（人工关停后重启恢复）', async () => {
    const { deps, created } = makeDeps([makeTask('self-healing-analysis'), makeTask('regression-verify', 'disabled')]);
    await ensureHealingScheduler(deps as never);
    expect(created).toEqual(['regression-verify']);
  });
});
