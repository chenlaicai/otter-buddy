/**
 * F20261006mtlp P1：matters 仓库 CRUD + open 查询单测。
 *
 * 覆盖：create/findById、findByConversation（openOnly/state/owner/waitingOn 过滤）、
 * 跨对话隔离（每对话一块板——搭档约束）。索引存在性由 schema.test.ts 全表扫描覆盖。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '@frameworks/db/schema';
import { SqliteMatterRepository } from '@frameworks/db/matter/sqlite-matter-repository';
import type { Matter } from '@entities/matter/matter';

function makeMatter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: crypto.randomUUID(),
    conversationId: 'conv-1',
    title: '事项',
    originMessageId: null,
    ownerOtterId: null,
    level: null,
    state: 'OPEN',
    waitingOn: null,
    waitingFor: null,
    payload: null,
    resolution: null,
    resolvedBy: null,
    createdAt: '2026-10-05T10:00:00.000Z',
    updatedAt: '2026-10-05T10:00:00.000Z',
    closedAt: null,
    ...overrides,
  };
}

describe('SqliteMatterRepository', () => {
  let db: Database.Database;
  let repo: SqliteMatterRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    repo = new SqliteMatterRepository(db);
  });

  it('create + findById roundtrip（字段全集）', async () => {
    const matter = makeMatter({
      title: 'healing 信号处置方式拍板',
      originMessageId: 'entry-yield-1',
      ownerOtterId: 'otter-1',
      level: 'L2',
      state: 'WAITING_PARTNER',
      waitingOn: 'partner',
      waitingFor: '选 A 还是 B',
      payload: '{"brief":"三层简报"}',
    });
    await repo.create(matter);
    const found = await repo.findById(matter.id);
    expect(found).toEqual(matter);
  });

  it('openOnly 过滤：只含四存续态，终态（CLOSED/SUPERSEDED/ABANDONED）排除', async () => {
    await repo.create(makeMatter({ state: 'OPEN' }));
    await repo.create(makeMatter({ state: 'WAITING_OTTER' }));
    await repo.create(makeMatter({ state: 'WAITING_PARTNER' }));
    await repo.create(makeMatter({ state: 'DONE_PENDING_CONFIRM' }));
    await repo.create(makeMatter({ state: 'CLOSED', closedAt: '2026-10-05T11:00:00.000Z' }));
    await repo.create(makeMatter({ state: 'SUPERSEDED', resolution: '被取代' }));
    await repo.create(makeMatter({ state: 'ABANDONED', resolution: '不做' }));

    const open = await repo.findByConversation('conv-1', { openOnly: true });
    expect(open.map(m => m.state).sort()).toEqual(
      ['DONE_PENDING_CONFIRM', 'OPEN', 'WAITING_OTTER', 'WAITING_PARTNER'].sort(),
    );
  });

  it('state/owner/waitingOn 过滤组合', async () => {
    await repo.create(makeMatter({ state: 'WAITING_PARTNER', waitingOn: 'partner', ownerOtterId: 'o1' }));
    await repo.create(makeMatter({ state: 'WAITING_PARTNER', waitingOn: 'partner', ownerOtterId: 'o2' }));
    await repo.create(makeMatter({ state: 'WAITING_OTTER', waitingOn: 'otter:o1', ownerOtterId: 'o1' }));

    const byOwner = await repo.findByConversation('conv-1', { ownerOtterId: 'o1' });
    expect(byOwner).toHaveLength(2);

    const byWaiting = await repo.findByConversation('conv-1', { waitingOn: 'partner' });
    expect(byWaiting).toHaveLength(2);

    const byState = await repo.findByConversation('conv-1', { state: 'WAITING_OTTER' });
    expect(byState).toHaveLength(1);
  });

  it('跨对话隔离（每对话一块板）', async () => {
    await repo.create(makeMatter({ conversationId: 'conv-1', title: 'A 对话事项' }));
    await repo.create(makeMatter({ conversationId: 'conv-2', title: 'B 对话事项' }));

    const conv1 = await repo.findByConversation('conv-1');
    expect(conv1).toHaveLength(1);
    expect(conv1[0].title).toBe('A 对话事项');
  });

  it('created_at 倒序（最新在前——板上先看到新事项）', async () => {
    await repo.create(makeMatter({ createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z' }));
    await repo.create(makeMatter({ createdAt: '2026-10-05T10:00:00.000Z', updatedAt: '2026-10-05T10:00:00.000Z' }));
    const all = await repo.findByConversation('conv-1');
    expect(all[0].createdAt).toBe('2026-10-05T10:00:00.000Z');
  });
});
