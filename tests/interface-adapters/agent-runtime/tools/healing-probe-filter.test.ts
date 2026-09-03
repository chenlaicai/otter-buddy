/**
 * #751：manage_healing_events query 默认过滤健康探针事件。
 *
 * 写入侧修复（探针写入即 resolved）保证新探针不进 open 池；
 * 本文件测消费侧兜底：历史遗留的 open/dismissed 探针事件，
 * query 默认不返回，includeProbe: true 时返回（诊断通道）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from '../../../helpers/db';
import { SqliteHealingEventRepository } from '@frameworks/db/healing/sqlite-healing-event-repository';
import { createManageHealingEventsTool } from '@interface-adapters/agent-runtime/tools/healing-tools';
import type { ToolContext } from '@usecases/ports/agent-tools';
import type { HealingEvent } from '@entities/healing/healing-event';
import { HEALING_PROBE_SENTINEL } from '@usecases/healing/constants';

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

/** #751 历史堆积探针样本：messageId/conversationId/otterId 均为哨兵 */
function seedProbeEvent(overrides: Partial<HealingEvent> = {}): HealingEvent {
  return seedEvent({
    messageId: HEALING_PROBE_SENTINEL,
    conversationId: HEALING_PROBE_SENTINEL,
    otterId: HEALING_PROBE_SENTINEL,
    errorType: 'other',
    severity: 'low',
    description: '健康探针测试记录（F20260827he2f）',
    ...overrides,
  });
}

const mockCtx = {
  otterId: 'otter-1', conversationId: 'conv-1', currentMessageId: 'msg-1',
  client: {} as Record<string, unknown>,
} as unknown as ToolContext;

describe('#751 manage_healing_events query 默认过滤探针', () => {
  let db: Database.Database;
  let repo: SqliteHealingEventRepository;
  let tool: ReturnType<typeof createManageHealingEventsTool>;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteHealingEventRepository(db);
    tool = createManageHealingEventsTool(mockCtx, repo);
  });
  afterEach(() => { db.close(); });

  it('query open 默认不含探针事件（历史 open 探针被过滤）', async () => {
    await repo.create(seedEvent({ id: 'evt-real-1' }));
    await repo.create(seedProbeEvent({ id: 'evt-probe-open', status: 'open' }));
    const result = await tool.execute('call-1', { action: 'query' });
    const events = JSON.parse(result.content[0].text);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('evt-real-1');
  });

  it('includeProbe: true 时返回探针事件（诊断通道）', async () => {
    await repo.create(seedProbeEvent({ id: 'evt-probe-open', status: 'open' }));
    await repo.create(seedProbeEvent({ id: 'evt-probe-resolved', status: 'resolved', resolvedAt: new Date().toISOString() }));
    const result = await tool.execute('call-1', { action: 'query', status: 'open', includeProbe: true });
    const events = JSON.parse(result.content[0].text);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('evt-probe-open');
    // resolved 池同样可诊断
    const resultResolved = await tool.execute('call-2', { action: 'query', status: 'resolved', includeProbe: true });
    const resolvedEvents = JSON.parse(resultResolved.content[0].text);
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0].id).toBe('evt-probe-resolved');
  });

  it('query resolved 默认不含探针（新探针写入即 resolved 也不刷屏展示位）', async () => {
    await repo.create(seedEvent({ id: 'evt-real-resolved', status: 'resolved', resolvedAt: new Date().toISOString() }));
    await repo.create(seedProbeEvent({ id: 'evt-probe-resolved', status: 'resolved', resolvedAt: new Date().toISOString() }));
    const result = await tool.execute('call-1', { action: 'query', status: 'resolved' });
    const events = JSON.parse(result.content[0].text);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('evt-real-resolved');
  });

  it('探针与真实事件混合时真实事件全部保留', async () => {
    for (let i = 0; i < 3; i++) await repo.create(seedEvent({ id: 'evt-real-' + i }));
    for (let i = 0; i < 5; i++) await repo.create(seedProbeEvent({ id: 'evt-probe-' + i }));
    const result = await tool.execute('call-1', { action: 'query' });
    const events = JSON.parse(result.content[0].text) as Array<{ id: string }>;
    expect(events).toHaveLength(3);
    expect(events.every(e => e.id.startsWith('evt-real-'))).toBe(true);
  });

  it('全探针池查询返回空数组（不误报、不报错）', async () => {
    await repo.create(seedProbeEvent({ id: 'evt-probe-1' }));
    const result = await tool.execute('call-1', { action: 'query' });
    const events = JSON.parse(result.content[0].text);
    expect(events).toHaveLength(0);
    expect(result.isError).toBeUndefined();
  });

  it('errorType 过滤与探针过滤叠加不冲突', async () => {
    await repo.create(seedEvent({ id: 'evt-real-tf', errorType: 'tool_failure' }));
    await repo.create(seedEvent({ id: 'evt-real-mc', errorType: 'missing_context' }));
    // 探针 errorType 同为 other，不会命中 tool_failure
    await repo.create(seedProbeEvent({ id: 'evt-probe', errorType: 'other' }));
    const result = await tool.execute('call-1', { action: 'query', errorType: 'tool_failure' });
    const events = JSON.parse(result.content[0].text);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('evt-real-tf');
  });
});
