/**
 * F20261008gfrc（三步走③·裁决摩擦）：batch_resolve 高危批量闸测试。
 *
 * 验证面：
 * 1. 匹配集中含 high → errorResponse 拒绝批量（含 high 条数与逐条处置指引）
 * 2. 匹配集全 low/medium → 正常批量 resolve（闸不放行面不误伤）
 * 3. dryRun 不触发闸（预览通道保持中性——dryRun 本就不产生处置）
 * 4. filterErrorType 收窄避开 high 后 → 批量放行（收窄路径可用）
 * 5. resolve/dismiss 逐条路径（eventIds）不受闸限制
 * 6. countByFilter（repo 层）：severity 条件进 WHERE、与 batchResolveByFilter 同语义
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from '../../../helpers/db';
import { SqliteHealingEventRepository } from '@frameworks/db/healing/sqlite-healing-event-repository';
import { createManageHealingEventsTool } from '@interface-adapters/agent-runtime/tools/healing-tools';
import type { ToolContext } from '@usecases/ports/agent-tools';
import type { HealingEvent } from '@entities/healing/healing-event';

function seedEvent(overrides: Partial<HealingEvent> = {}): HealingEvent {
  return {
    id: 'he-' + Math.random().toString(36).slice(2, 8),
    messageId: 'msg-1', conversationId: 'conv-1', otterId: 'otter-1',
    errorType: 'tool_failure', severity: 'low', description: 'test event',
    suggestion: '', context: null, status: 'open', resolution: null,
    createdAt: new Date().toISOString(), resolvedAt: null,
    ...overrides,
  };
}

const mockCtx = {
  otterId: 'otter-1', conversationId: 'conv-1', currentMessageId: 'msg-1',
  client: {} as Record<string, unknown>,
} as unknown as ToolContext;

describe('F20261008gfrc batch_resolve 高危批量闸', () => {
  let db: Database.Database;
  let repo: SqliteHealingEventRepository;
  let tool: ReturnType<typeof createManageHealingEventsTool>;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteHealingEventRepository(db);
    tool = createManageHealingEventsTool(mockCtx, repo);
  });
  afterEach(() => { db.close(); });

  it('匹配集含 high → 拒绝批量并给出逐条处置指引', async () => {
    await repo.create(seedEvent({ id: 'evt-low', severity: 'low' }));
    await repo.create(seedEvent({ id: 'evt-high', severity: 'high' }));
    const result = await tool.execute('call-1', { action: 'batch_resolve' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('1 条 high severity');
    expect(result.content[0].text).toContain('逐条处置');
    // 事件未被静默——low 事件也保持 open（闸在更新前拦截整批）
    expect(await repo.findAll('open')).toHaveLength(2);
  });

  it('匹配集全 low/medium → 正常批量 resolve（闸不误伤）', async () => {
    await repo.create(seedEvent({ id: 'evt-low', severity: 'low' }));
    await repo.create(seedEvent({ id: 'evt-med', severity: 'medium' }));
    const result = await tool.execute('call-1', { action: 'batch_resolve' });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.resolved).toBe(2);
    expect(await repo.findAll('open')).toHaveLength(0);
  });

  it('dryRun 预览不触发闸', async () => {
    await repo.create(seedEvent({ id: 'evt-high', severity: 'high' }));
    const result = await tool.execute('call-1', { action: 'batch_resolve', dryRun: true });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).matched).toBe(1);
  });

  it('filterErrorType 收窄避开 high → 批量放行', async () => {
    await repo.create(seedEvent({ id: 'evt-high', severity: 'high', errorType: 'guard_intercept' }));
    await repo.create(seedEvent({ id: 'evt-low', severity: 'low', errorType: 'tool_failure' }));
    const result = await tool.execute('call-1', { action: 'batch_resolve', filterErrorType: 'tool_failure' });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.resolved).toBe(1);
    // high 事件保持 open（未被误伤）
    const open = await repo.findAll('open');
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe('evt-high');
  });

  it('逐条 resolve（eventIds 路径）不受闸限制', async () => {
    await repo.create(seedEvent({ id: 'evt-high', severity: 'high' }));
    const result = await tool.execute('call-1', { action: 'resolve', eventIds: ['evt-high'], resolutionNotes: '人工核实过' });
    expect(result.isError).toBeUndefined();
    expect(await repo.findAll('open')).toHaveLength(0);
  });
});

describe('F20261008gfrc countByFilter（repo 层）', () => {
  let db: Database.Database;
  let repo: SqliteHealingEventRepository;
  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteHealingEventRepository(db);
  });
  afterEach(() => { db.close(); });

  it('severity 条件进 WHERE（只数 high，忽略 low/medium）', async () => {
    await repo.create(seedEvent({ severity: 'low' }));
    await repo.create(seedEvent({ severity: 'medium' }));
    await repo.create(seedEvent({ severity: 'high' }));
    await repo.create(seedEvent({ severity: 'high' }));
    const count = await repo.countByFilter({ status: 'open', severity: 'high' });
    expect(count).toBe(2);
  });

  it('与 batchResolveByFilter 同 WHERE 语义（errorType 交叠）', async () => {
    await repo.create(seedEvent({ severity: 'high', errorType: 'guard_intercept' }));
    await repo.create(seedEvent({ severity: 'high', errorType: 'tool_failure' }));
    const count = await repo.countByFilter({ status: 'open', severity: 'high', errorType: 'tool_failure' });
    expect(count).toBe(1);
  });
});
