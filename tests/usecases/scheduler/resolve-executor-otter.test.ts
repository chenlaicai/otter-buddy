import { describe, expect, it } from 'vitest';
import { resolveExecutorOtter } from '@usecases/scheduler/resolve-executor-otter';
import type { Otter } from '@entities/otter/otter';

function otter(id: string, name = '大獭', type = 'big', status: Otter['status'] = 'active'): Otter {
  return {
    id, name, type, status, color: null, role: null, parentOtterId: null,
    createdAt: '2026-01-01T00:00:00.000Z', dissolvedAt: status === 'dissolved' ? '2026-02-01T00:00:00.000Z' : null,
  };
}

function deps(otters: Otter[], activeIds: string[], activity: Record<string, string> = {}) {
  const byId = new Map(otters.map(o => [o.id, o]));
  return {
    otterRepo: { getById: async (id: string) => byId.get(id) ?? null },
    convRepo: {
      getActiveParticipants: async () => activeIds.map((otterId, index) => ({
        id: `p-${index}`, conversationId: 'conv-1', otterId, status: 'active' as const,
        createdAt: '2026-01-01T00:00:00.000Z', leftAt: null, lastReadSeq: 0,
      })),
      getLastInvokeStartedAtByOtter: () => new Map(Object.entries(activity)),
      getLastSpeakBySender: () => new Map<string, { seq: number; createdAt: string }>(),
    },
  };
}

const task = { conversationId: 'conv-1', executorRole: '大獭', talkingStonePassedTo: ['legacy-big'] };

describe('resolveExecutorOtter（角色名 + 类型 + active 名册）', () => {
  it('同名大獭多实例取最近活跃，而不是建任务时旧 ID', async () => {
    const result = await resolveExecutorOtter(task, deps(
      [otter('legacy-big'), otter('current-big')],
      ['legacy-big', 'current-big'],
      { 'current-big': '2026-10-21T12:00:00.000Z', 'legacy-big': '2026-10-01T12:00:00.000Z' },
    ));
    expect(result.otter).toMatchObject({ id: 'current-big', source: 'role' });
  });

  it('历史实例不在 active 名册时不会被选中', async () => {
    const result = await resolveExecutorOtter(task, deps(
      [otter('legacy-big'), otter('current-big')], ['current-big'],
    ));
    expect(result.otter?.id).toBe('current-big');
  });

  it('同名 small 不匹配大獭角色；名册无 big 时才启用旧实例 fallback', async () => {
    const result = await resolveExecutorOtter(task, deps(
      [otter('same-name-small', '大獭', 'small'), otter('legacy-big')],
      ['same-name-small'],
    ));
    expect(result.otter).toMatchObject({ id: 'legacy-big', source: 'fallback' });
  });

  it('名册和 fallback 都不可用才失败，错误语义稳定', async () => {
    const result = await resolveExecutorOtter(
      { ...task, talkingStonePassedTo: ['gone-big'] },
      deps([otter('gone-big', '大獭', 'big', 'dissolved')], []),
    );
    expect(result).toEqual({ otter: null, reason: 'no-such-role-in-roster' });
  });
});
