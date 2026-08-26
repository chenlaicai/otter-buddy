/**
 * F20260826mwrd C1：signal_events 仓库 CRUD 单测。
 *
 * 覆盖：create/findByConversation（过滤组合）/resolve（幂等防重——
 * 已裁决的信号不可被二次 resolve，裁决写路径唯一性）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '@frameworks/db/schema';
import { SqliteSignalEventRepository } from '@frameworks/db/signal/sqlite-signal-repository';
import type { SignalEvent } from '@entities/signal/signal-event';

function makeEvent(overrides: Partial<SignalEvent> = {}): SignalEvent {
  return {
    id: 'sig-001',
    conversationId: 'conv-1',
    messageId: 'msg-1',
    fromOtterId: 'otter-big',
    targetOtterId: 'otter-small',
    type: 'halt',
    severity: 'high',
    payload: '停手理由',
    status: 'pending',
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: '2026-08-26T10:00:00.000Z',
    ...overrides,
  };
}

describe('SqliteSignalEventRepository', () => {
  let db: Database.Database;
  let repo: SqliteSignalEventRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    repo = new SqliteSignalEventRepository(db);
  });

  it('create + findById roundtrip（含 targetOtterId 可空）', async () => {
    await repo.create(makeEvent());
    const found = await repo.findById('sig-001');
    expect(found).not.toBeNull();
    expect(found!.type).toBe('halt');
    expect(found!.targetOtterId).toBe('otter-small');

    // C2 的 objection 无 target
    await repo.create(makeEvent({ id: 'sig-002', type: 'objection', targetOtterId: null, messageId: 'msg-2' }));
    const objection = await repo.findById('sig-002');
    expect(objection!.targetOtterId).toBeNull();
  });

  it('findByConversation 过滤组合：type + status + target', async () => {
    await repo.create(makeEvent({ id: 'a' }));
    await repo.create(makeEvent({ id: 'b', status: 'resolved', resolution: '已处置' }));
    await repo.create(makeEvent({ id: 'c', type: 'objection', targetOtterId: null }));
    await repo.create(makeEvent({ id: 'd', conversationId: 'conv-2' }));

    const all = await repo.findByConversation('conv-1');
    expect(all).toHaveLength(3);

    const haltPending = await repo.findByConversation('conv-1', { type: 'halt', status: 'pending' });
    expect(haltPending.map(e => e.id)).toEqual(['a']);

    const byTarget = await repo.findByConversation('conv-1', { targetOtterId: 'otter-small' });
    expect(byTarget).toHaveLength(2);
  });

  it('resolve：pending → resolved，resolvedBy/resolution 落库', async () => {
    await repo.create(makeEvent());
    const updated = await repo.resolve('sig-001', 'resolved', '指令已注入', 'system');
    expect(updated!.status).toBe('resolved');
    expect(updated!.resolvedBy).toBe('system');
    expect(updated!.resolution).toBe('指令已注入');
    expect(updated!.resolvedAt).not.toBeNull();
  });

  it('resolve 幂等防重：已裁决的信号不可二次 resolve', async () => {
    await repo.create(makeEvent());
    const first = await repo.resolve('sig-001', 'resolved', '第一次裁决', 'system');
    expect(first!.status).toBe('resolved');

    const second = await repo.resolve('sig-001', 'dismissed', '试图翻案', 'otter-evil');
    expect(second).not.toBeNull(); // 返回当前实体（读回确认）
    expect(second!.status).toBe('resolved'); // 但状态未被翻改
    expect(second!.resolution).toBe('第一次裁决'); // 裁决保持首次内容
  });

  it('resolve 不存在的 id 返回 null', async () => {
    const result = await repo.resolve('nope', 'resolved', 'x', 'system');
    expect(result).toBeNull();
  });
});
