/**
 * #1370（F20261009hefs）：manage_healing_events 对不存在 eventIds 假成功的修复验证。
 *
 * 根因：better-sqlite3 UPDATE 不匹配返回 changes=0 但不抛错，
 * Promise.allSettled 因此全部 fulfilled → 回执假成功。
 *
 * 验证面（issue 关闭标准三态）：
 * 1. 全失败：全部 ID 不存在 → isError=true，失败计数 N/N，列明无效 ID，库无变更
 * 2. 部分失败：1 真 1 假混合 → isError=true，「N/M 成功」，真 ID 已处置、假 ID 列明
 * 3. 全成功：全部 ID 存在 → 原成功回执路径不回归
 * 4. dismiss 路径同语义（updateStatus 同样吞掉 changes=0）
 * 5. repo 层防护：resolve/updateStatus 对不存在 ID 抛错（changes=0 fail-closed）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../helpers/db';
import { SqliteHealingEventRepository } from '@frameworks/db/healing/sqlite-healing-event-repository';
import { createManageHealingEventsTool } from '@interface-adapters/agent-runtime/tools/healing-tools';
import type { ToolContext } from '@usecases/ports/agent-tools';
import type { HealingEvent } from '@entities/healing/healing-event';

function seedEvent(overrides: Partial<HealingEvent> = {}): HealingEvent {
  return {
    id: 'he-' + Math.random().toString(36).slice(2, 8),
    messageId: 'msg-1', conversationId: 'conv-1', otterId: 'otter-1',
    errorType: 'guard_intercept', severity: 'low', description: 'test event',
    suggestion: '', context: null, status: 'open', resolution: null,
    createdAt: new Date().toISOString(), resolvedAt: null,
    ...overrides,
  };
}

const mockCtx = {
  otterId: 'otter-1', conversationId: 'conv-1', currentMessageId: 'msg-1',
  client: {} as Record<string, unknown>,
} as unknown as ToolContext;

describe('#1370 resolve/dismiss 对不存在 eventIds 假成功', () => {
  let db: Database.Database;
  let repo: SqliteHealingEventRepository;
  let tool: ReturnType<typeof createManageHealingEventsTool>;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteHealingEventRepository(db);
    tool = createManageHealingEventsTool(mockCtx, repo);
  });
  afterEach(() => { db.close(); });

  it('全失败：不存在 ID 调 resolve → isError + 列明无效 ID + 库无变更', async () => {
    const result = await tool.execute('call-1', {
      action: 'resolve',
      eventIds: ['b4eeff04-dc5c-4821-9348-3168f616f561', 'ghost-id-2'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('0/2 成功');
    expect(result.content[0].text).toContain('b4eeff04-dc5c-4821-9348-3168f616f561');
    expect(result.content[0].text).toContain('ghost-id-2');
    expect(await repo.findAll('open')).toHaveLength(0);
    expect(await repo.findAll('resolved')).toHaveLength(0);
  });

  it('部分失败：1 真 1 假混合 → isError + 真 ID 已处置 + 假 ID 列明', async () => {
    await repo.create(seedEvent({ id: 'evt-real' }));
    const result = await tool.execute('call-1', {
      action: 'resolve',
      eventIds: ['evt-real', 'evt-ghost'],
      resolutionNotes: '核实后关闭',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('1/2 成功');
    expect(result.content[0].text).toContain('evt-ghost');
    // 真 ID 已落库处置，假 ID 无声消失是不可能的（已列明）
    expect(await repo.findAll('open')).toHaveLength(0);
    expect(await repo.findAll('resolved')).toHaveLength(1);
  });

  it('全成功：全部 ID 存在 → 原成功回执路径不回归', async () => {
    await repo.create(seedEvent({ id: 'evt-1' }));
    await repo.create(seedEvent({ id: 'evt-2' }));
    const result = await tool.execute('call-1', {
      action: 'resolve',
      eventIds: ['evt-1', 'evt-2'],
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('2/2 成功');
    expect(await repo.findAll('open')).toHaveLength(0);
    expect(await repo.findAll('resolved')).toHaveLength(2);
  });

  it('dismiss 路径：不存在 ID → isError 而非假成功', async () => {
    await repo.create(seedEvent({ id: 'evt-real' }));
    const result = await tool.execute('call-1', {
      action: 'dismiss',
      eventIds: ['evt-real', 'evt-ghost'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('1/2 成功');
    expect(await repo.findAll('dismissed')).toHaveLength(1);
  });
});

describe('#1370 repo 层防护（changes=0 fail-closed）', () => {
  let db: Database.Database;
  let repo: SqliteHealingEventRepository;
  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteHealingEventRepository(db);
  });
  afterEach(() => { db.close(); });

  it('resolve 不存在 ID → 抛错', async () => {
    await expect(repo.resolve('nope', {
      action: 'no_action', decidedBy: 'agent', decidedAt: new Date().toISOString(), notes: '',
    })).rejects.toThrow(/不存在/);
  });

  it('updateStatus 不存在 ID → 抛错', async () => {
    await expect(repo.updateStatus('nope', 'dismissed')).rejects.toThrow(/不存在/);
  });

  it('resolve 存在 ID → 正常落库（防护不误伤）', async () => {
    await repo.create(seedEvent({ id: 'evt-real' }));
    await repo.resolve('evt-real', {
      action: 'no_action', decidedBy: 'agent', decidedAt: new Date().toISOString(), notes: '',
    });
    const resolved = await repo.findAll('resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe('evt-real');
  });
});
