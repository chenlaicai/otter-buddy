/**
 * manage_healing_events batch_resolve 工具层测试。
 *
 * 测试 handleBatchResolve 的参数映射、dryRun 分支、ISO 校验、truncated 标志。
 * 检视獭-454 发现 4 要求补的回归保护。
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

describe('manage_healing_events batch_resolve 工具层', () => {
  let db: Database.Database;
  let repo: SqliteHealingEventRepository;
  let tool: ReturnType<typeof createManageHealingEventsTool>;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteHealingEventRepository(db);
    tool = createManageHealingEventsTool(mockCtx, repo);
  });
  afterEach(() => { db.close(); });

  it('dryRun 返回匹配数不执行 resolve', async () => {
    await repo.create(seedEvent({ id: 'evt-1' }));
    await repo.create(seedEvent({ id: 'evt-2' }));
    const result = await tool.execute('call-1', { action: 'batch_resolve', dryRun: true });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.dryRun).toBe(true);
    expect(body.matched).toBe(2);
    const open = await repo.findAll('open');
    expect(open).toHaveLength(2);
  });

  it('真实执行返回 resolved + truncated', async () => {
    for (let i = 0; i < 150; i++) await repo.create(seedEvent({ id: 'evt-' + i }));
    const result = await tool.execute('call-1', { action: 'batch_resolve' });
    const body = JSON.parse(result.content[0].text);
    expect(body.matched).toBe(100);
    expect(body.resolved).toBe(100);
    expect(body.truncated).toBe(true);
    expect(body.totalMatched).toBe(150);
    const remaining = await repo.findAll('open');
    expect(remaining).toHaveLength(50);
  });

  it('未截断时 truncated=false', async () => {
    await repo.create(seedEvent({ id: 'evt-1' }));
    const result = await tool.execute('call-1', { action: 'batch_resolve' });
    const body = JSON.parse(result.content[0].text);
    expect(body.matched).toBe(1);
    expect(body.truncated).toBe(false);
    expect(body.totalMatched).toBe(1);
  });

  it('filterErrorType 参数映射正确', async () => {
    await repo.create(seedEvent({ id: 'evt-1', errorType: 'tool_failure' }));
    await repo.create(seedEvent({ id: 'evt-2', errorType: 'missing_context' }));
    const result = await tool.execute('call-1', { action: 'batch_resolve', filterErrorType: 'tool_failure' });
    const body = JSON.parse(result.content[0].text);
    expect(body.resolved).toBe(1);
    expect(body.resolvedIds).toEqual(['evt-1']);
  });

  it('非法 ISO 日期返回明确错误', async () => {
    const result = await tool.execute('call-1', { action: 'batch_resolve', filterCreatedBefore: 'garbage' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ISO 8601');
    expect(result.content[0].text).toContain('garbage');
  });

  it('非法日期格式 06/01/2026 被拒绝', async () => {
    const result = await tool.execute('call-1', { action: 'batch_resolve', filterCreatedAfter: '06/01/2026' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ISO 8601');
  });

  it('空结果返回 matched=0', async () => {
    const result = await tool.execute('call-1', { action: 'batch_resolve' });
    const body = JSON.parse(result.content[0].text);
    expect(body.matched).toBe(0);
    expect(body.resolved).toBe(0);
  });
});
