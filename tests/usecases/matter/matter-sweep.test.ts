/**
 * F20261008mlp3 P3：MatterSweep usecase + SqliteMatterRepository 停滞扫描扩展测试。
 *
 * 验证节锁定项「未闭环扫描升格」：
 * - stalledOpen：OPEN 无人认领 / WAITING_PARTNER 积压——跨日未收尾（24h 基准）
 * - recentYieldsToUser：漏登记的 L2 待裁决项兜底（yield entry 超阈未登记 matter）
 * - MatterSweep.execute：组合查询，返回停滞 matter + 候选漏登记 yield
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '@frameworks/db/schema';
import { SqliteMatterRepository } from '@frameworks/db/matter/sqlite-matter-repository';
import { MatterSweep } from '@usecases/matter/matter-sweep';

const NOW = new Date('2026-10-08T07:30:00Z');

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 3_600_000).toISOString();
}

function seedMatter(
  repo: SqliteMatterRepository,
  overrides: Partial<{
    id: string;
    conversationId: string;
    title: string;
    state: string;
    ownerOtterId: string | null;
    level: string | null;
    waitingOn: string | null;
    waitingFor: string | null;
    createdAt: string;
    updatedAt: string;
  }>,
): void {
  const db = (repo as unknown as { db: Database.Database }).db;
  db.prepare(`
    INSERT INTO matters (
      id, conversation_id, title, origin_message_id, owner_otter_id,
      level, state, waiting_on, waiting_for, payload, resolution, resolved_by,
      created_at, updated_at, closed_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)
  `).run(
    overrides.id ?? crypto.randomUUID(),
    overrides.conversationId ?? 'conv-1',
    overrides.title ?? '测试事项',
    overrides.ownerOtterId ?? null,
    overrides.level ?? null,
    overrides.state ?? 'OPEN',
    overrides.waitingOn ?? null,
    overrides.waitingFor ?? null,
    overrides.createdAt ?? isoDaysAgo(2),
    overrides.updatedAt ?? isoDaysAgo(2),
  );
}

describe('MatterSweep（F20261008mlp3 P3——未闭环扫描升格）', () => {
  let db: Database.Database;
  let repo: SqliteMatterRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    // 外键约束：entries 表依赖 conversations / otters
    db.prepare("INSERT INTO otters (id, name, type) VALUES ('otter-1', '大獭', 'big')").run();
    db.prepare("INSERT INTO conversations (id, title, status) VALUES ('conv-1', '测试对话', 'active')").run();
    repo = new SqliteMatterRepository(db);
  });

  it('停滞扫描：OPEN 无人认领（>24h）命中', async () => {
    seedMatter(repo, {
      id: 'm-1',
      title: '回头再看的重构项',
      state: 'OPEN',
      updatedAt: isoDaysAgo(2),
    });
    const sweep = new MatterSweep(repo);
    const result = await sweep.execute(NOW);
    expect(result.stalled).toHaveLength(1);
    expect(result.stalled[0].id).toBe('m-1');
    expect(result.stalled[0].state).toBe('OPEN');
    expect(result.stalled[0].stalledHours).toBe(48);
  });

  it('停滞扫描：WAITING_PARTNER 积压（>24h）命中', async () => {
    seedMatter(repo, {
      id: 'm-2',
      title: '等拍板的方案',
      state: 'WAITING_PARTNER',
      waitingOn: 'partner',
      waitingFor: '拍板',
      updatedAt: isoDaysAgo(3),
    });
    const sweep = new MatterSweep(repo);
    const result = await sweep.execute(NOW);
    expect(result.stalled).toHaveLength(1);
    expect(result.stalled[0].state).toBe('WAITING_PARTNER');
    expect(result.stalled[0].stalledHours).toBe(72);
  });

  it('停滞扫描：新登记的 OPEN（<24h）也命中——OPEN 即积压（无人认领）', async () => {
    seedMatter(repo, {
      id: 'm-3',
      title: '刚登记的事',
      state: 'OPEN',
      updatedAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(), // 2h 前
    });
    const sweep = new MatterSweep(repo);
    const result = await sweep.execute(NOW);
    expect(result.stalled).toHaveLength(1);
    expect(result.stalled[0].id).toBe('m-3');
    expect(result.stalled[0].stalledHours).toBe(2);
  });

  it('停滞扫描：新 WAITING_PARTNER（<24h）不命中', async () => {
    seedMatter(repo, {
      id: 'm-4',
      title: '刚呈拍板',
      state: 'WAITING_PARTNER',
      waitingOn: 'partner',
      updatedAt: new Date(NOW.getTime() - 1 * 3_600_000).toISOString(), // 1h 前
    });
    const sweep = new MatterSweep(repo);
    const result = await sweep.execute(NOW);
    expect(result.stalled).toHaveLength(0);
  });

  it('停滞扫描：终态 matter 不命中', async () => {
    seedMatter(repo, {
      id: 'm-5',
      title: '已闭环',
      state: 'CLOSED',
      updatedAt: isoDaysAgo(5),
    });
    const sweep = new MatterSweep(repo);
    const result = await sweep.execute(NOW);
    expect(result.stalled).toHaveLength(0);
  });

  it('漏登记 yield 兜底：近 7 天超阈 yield 条目命中', async () => {
    db.prepare(`
      INSERT INTO entries (
        id, conversation_id, sequence_num, entry_type, sender_type, sender_id,
        body, invoke_id, yield_targets, status, source, metadata, sender_name,
        context_tokens, context_tokens_max, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'e-1',
      'conv-1',
      1,
      'yield',
      'otter',
      'otter-1',
      '呈拍板：方案 A vs B',
      null,
      '["user"]',
      'completed',
      null,
      null,
      '大獭',
      null,
      null,
      isoDaysAgo(2),
      null,
    );
    const sweep = new MatterSweep(repo);
    const result = await sweep.execute(NOW);
    expect(result.unregisteredYields).toHaveLength(1);
    expect(result.unregisteredYields[0].id).toBe('e-1');
    expect(result.unregisteredYields[0].body).toContain('方案 A vs B');
  });

  it('漏登记 yield 兜底：超窗（>7 天）不命中', async () => {
    db.prepare(`
      INSERT INTO entries (
        id, conversation_id, sequence_num, entry_type, sender_type, sender_id,
        body, invoke_id, yield_targets, status, source, metadata, sender_name,
        context_tokens, context_tokens_max, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'e-2',
      'conv-1',
      1,
      'yield',
      'otter',
      'otter-1',
      '旧 yield',
      null,
      '["user"]',
      'completed',
      null,
      null,
      '大獭',
      null,
      null,
      isoDaysAgo(10),
      null,
    );
    const sweep = new MatterSweep(repo);
    const result = await sweep.execute(NOW);
    expect(result.unregisteredYields).toHaveLength(0);
  });

  it('漏登记 yield 兜底：yield_targets 不含 user 不命中', async () => {
    db.prepare(`
      INSERT INTO entries (
        id, conversation_id, sequence_num, entry_type, sender_type, sender_id,
        body, invoke_id, yield_targets, status, source, metadata, sender_name,
        context_tokens, context_tokens_max, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'e-3',
      'conv-1',
      1,
      'yield',
      'otter',
      'otter-1',
      '交棒给协作獭',
      null,
      '["otter-2"]',
      'completed',
      null,
      null,
      '大獭',
      null,
      null,
      isoDaysAgo(2),
      null,
    );
    const sweep = new MatterSweep(repo);
    const result = await sweep.execute(NOW);
    expect(result.unregisteredYields).toHaveLength(0);
  });

  it('组合扫描：停滞 matter + 漏登记 yield 同时返回', async () => {
    seedMatter(repo, { id: 'm-6', title: '停滞 A', state: 'OPEN', updatedAt: isoDaysAgo(2) });
    db.prepare(`
      INSERT INTO entries (
        id, conversation_id, sequence_num, entry_type, sender_type, sender_id,
        body, invoke_id, yield_targets, status, source, metadata, sender_name,
        context_tokens, context_tokens_max, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'e-4', 'conv-1', 1, 'yield', 'otter', 'otter-1', 'yield body', null, '["user"]',
      'completed', null, null, '大獭', null, null, isoDaysAgo(1), null,
    );
    const sweep = new MatterSweep(repo);
    const result = await sweep.execute(NOW);
    expect(result.stalled).toHaveLength(1);
    expect(result.unregisteredYields).toHaveLength(1);
    expect(result.scannedAt).toBe(NOW.toISOString());
  });
});
