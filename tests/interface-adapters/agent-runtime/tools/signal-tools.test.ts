/**
 * F20260826mwrd C1：halt_otter / query_signals 工具单测。
 *
 * 覆盖：参数校验（reason 必填/目标解析失败）、自我 halt 拒绝、打标+落账联动、
 * 台账查询过滤。mock ToolContext（client.conversation.participant.getActive）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '@frameworks/db/schema';
import { SqliteSignalEventRepository } from '@frameworks/db/signal/sqlite-signal-repository';
import { createHaltOtterTool, createQuerySignalsTool, createResolveSignalTool, parseSignalParam, persistSignalEvents, SPEAK_SIGNAL_PARAM_SCHEMA } from '@interface-adapters/agent-runtime/tools/signal-tools';
import { haltRegistry } from '@usecases/signal/halt-registry';
import { signalAlertRegistry } from '@usecases/signal/signal-alert-registry';
import type { ToolContext } from '@usecases/ports/agent-tools';
import type { OtterToolClient } from '@usecases/ports/otter-tool-client';

function makeCtx(): ToolContext {
  const client = {
    conversation: {
      participant: {
        getActive: async () => [
          { otterId: 'otter-big', otterName: '大獭', conversationId: 'conv-1', joinedAtTurnNumber: 1, status: 'active' },
          { otterId: 'otter-small-1', otterName: '开发獭-C1', conversationId: 'conv-1', joinedAtTurnNumber: 2, status: 'active' },
        ],
      },
    },
  } as unknown as OtterToolClient;
  return { client, otterId: 'otter-big', conversationId: 'conv-1', currentMessageId: 'msg-9' };
}

describe('halt_otter 工具', () => {
  let db: Database.Database;
  let repo: SqliteSignalEventRepository;
  let ctx: ToolContext;

  beforeEach(() => {
    haltRegistry.resetForTest();
    db = new Database(':memory:');
    initSchema(db);
    repo = new SqliteSignalEventRepository(db);
    ctx = makeCtx();
  });

  it('reason 缺失拒绝', async () => {
    const tool = createHaltOtterTool(ctx, repo);
    const res = await tool.execute('t1', { otterName: '开发獭-C1' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('reason 必填');
  });

  it('按名字解析目标成功：打标 + 落账 pending', async () => {
    const tool = createHaltOtterTool(ctx, repo);
    const res = await tool.execute('t1', { otterName: '开发獭-C1', reason: '方向错了' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('halt');

    expect(haltRegistry.isHalted('otter-small-1')).toBe(true);
    const events = await repo.findByConversation('conv-1', { type: 'halt' });
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('pending');
    expect(events[0].targetOtterId).toBe('otter-small-1');
    expect(events[0].payload).toBe('方向错了');
  });

  it('目标名不存在时给出可操作错误', async () => {
    const tool = createHaltOtterTool(ctx, repo);
    const res = await tool.execute('t1', { otterName: '不存在的獭', reason: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('找不到');
    expect(haltRegistry.isHalted('otter-small-1')).toBe(false);
  });

  it('自我 halt 拒绝（大獭停自己无意义）', async () => {
    const tool = createHaltOtterTool(ctx, repo);
    const res = await tool.execute('t1', { otterId: 'otter-big', reason: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('不能 halt 自己');
  });

  it('otterId 直传不在场也允许打标（名字回退 ID）', async () => {
    const tool = createHaltOtterTool(ctx, repo);
    const res = await tool.execute('t1', { otterId: 'otter-ghost', reason: 'x' });
    expect(res.isError).toBeUndefined();
    expect(haltRegistry.isHalted('otter-ghost')).toBe(true);
  });
});

describe('query_signals 工具', () => {
  let db: Database.Database;
  let repo: SqliteSignalEventRepository;
  let ctx: ToolContext;

  beforeEach(async () => {
    haltRegistry.resetForTest();
    db = new Database(':memory:');
    initSchema(db);
    repo = new SqliteSignalEventRepository(db);
    ctx = makeCtx();
    // 造数据：1 halt pending + 1 halt resolved + 1 objection
    const mk = (o: Record<string, unknown>) => repo.create({
      id: 'x', conversationId: 'conv-1', messageId: 'm', fromOtterId: 'otter-big', targetOtterId: 'otter-small-1',
      type: 'halt', severity: 'high', payload: 'p', status: 'pending', resolution: null, resolvedBy: null, resolvedAt: null,
      createdAt: '2026-08-26T10:00:00.000Z', ...o,
    } as Parameters<typeof repo.create>[0]);
    await mk({ id: 'h1' });
    await mk({ id: 'h2', status: 'resolved', resolution: '已注入' });
    await mk({ id: 'o1', type: 'objection', targetOtterId: null });
  });

  it('无过滤返回全部', async () => {
    const tool = createQuerySignalsTool(ctx, repo);
    const res = await tool.execute('t1', {});
    expect(res.content[0].text).toContain('3 条');
  });

  it('type/status 过滤生效', async () => {
    const tool = createQuerySignalsTool(ctx, repo);
    const pending = await tool.execute('t1', { type: 'halt', status: 'pending' });
    expect(pending.content[0].text).toContain('h1');
    expect(pending.content[0].text).not.toContain('o1');
  });
});

describe('parseSignalParam（F20261113sgnpr：speak 参数解析）', () => {
  it('未传/空数组返回空 signals 无 error', () => {
    expect(parseSignalParam(undefined)).toEqual({ signals: [], error: null });
    expect(parseSignalParam([])).toEqual({ signals: [], error: null });
  });

  it('合法单条：type/severity/payload 解析 + 超长截断', () => {
    const long = 'x'.repeat(1500);
    const res = parseSignalParam([{ type: 'blocked', severity: 'high', payload: long }]);
    expect(res.error).toBeNull();
    expect(res.signals).toHaveLength(1);
    expect(res.signals[0]).toEqual({ type: 'blocked', severity: 'high', payload: long.slice(0, 1000) });
  });

  it('severity 缺省 medium（降低结构化写作负担）', () => {
    const res = parseSignalParam([{ type: 'objection', payload: '事实依据含锚点' }]);
    expect(res.error).toBeNull();
    expect(res.signals[0].severity).toBe('medium');
  });

  it('非法参数各型原子拒绝（不落账不发言）', () => {
    expect(parseSignalParam({}).error).toContain('数组');
    expect(parseSignalParam(Array.from({ length: 6 }, () => ({ type: 'objection', payload: 'x' }))).error).toContain('最多');
    expect(parseSignalParam([{ type: 'halt', severity: 'high', payload: '伪造' }]).error).toContain('halt');
    expect(parseSignalParam([{ type: 'objection', payload: '   ' }]).error).toContain('payload');
    expect(parseSignalParam([{ type: 'objection', severity: 'critical', payload: 'x' }]).error).toContain('severity');
    expect(parseSignalParam([{ type: 'objection', payload: 'x' }, 'bad']).error).toContain('对象');
  });

  it('SPEAK_SIGNAL_PARAM_SCHEMA 白名单与解析器同源', () => {
    expect(SPEAK_SIGNAL_PARAM_SCHEMA.items.properties.type.enum).toEqual(['objection', 'blocked']);
    expect(SPEAK_SIGNAL_PARAM_SCHEMA.items.properties.severity.enum).toEqual(['low', 'medium', 'high']);
  });
});

describe('persistSignalEvents（F20261113sgnpr：参数法落账）', () => {
  let db: Database.Database;
  let repo: SqliteSignalEventRepository;
  let ctx: ToolContext;

  beforeEach(() => {
    haltRegistry.resetForTest();
    signalAlertRegistry.resetForTest();
    db = new Database(':memory:');
    initSchema(db);
    repo = new SqliteSignalEventRepository(db);
    ctx = makeCtx();
  });

  it('合法信号落账 pending + 登记提醒', async () => {
    persistSignalEvents([{ type: 'objection', severity: 'medium', payload: '派工与 F20260814xxxx 冲突' }], ctx, repo);
    await vi.waitFor(async () => {
      const events = await repo.findByConversation('conv-1', { type: 'objection' });
      expect(events).toHaveLength(1);
      expect(events[0].status).toBe('pending');
      expect(events[0].fromOtterId).toBe('otter-big');
      expect(events[0].payload).toContain('F20260814xxxx');
    });
    expect(signalAlertRegistry.takeAll('conv-1')).toHaveLength(1);
  });

  it('多条信号逐条落账 pending', async () => {
    persistSignalEvents([
      { type: 'objection', severity: 'low', payload: '异议A' },
      { type: 'blocked', severity: 'high', payload: '卡住B：已试清单' },
    ], ctx, repo);
    await vi.waitFor(async () => {
      const events = await repo.findByConversation('conv-1');
      expect(events).toHaveLength(2);
      expect(events.map(e => e.type).sort()).toEqual(['blocked', 'objection']);
      expect(events.every(e => e.status === 'pending')).toBe(true);
    });
    expect(signalAlertRegistry.takeAll('conv-1')).toHaveLength(2);
  });
});

describe('resolve_signal 工具（C2：裁决写路径）', () => {
  let db: Database.Database;
  let repo: SqliteSignalEventRepository;
  let ctx: ToolContext;

  beforeEach(async () => {
    db = new Database(':memory:');
    initSchema(db);
    repo = new SqliteSignalEventRepository(db);
    ctx = makeCtx();
    await repo.create({
      id: 'aaaaaaaa-1111-2222-3333-444444444444', conversationId: 'conv-1', messageId: 'm1',
      fromOtterId: 'otter-small-1', targetOtterId: null, type: 'objection', severity: 'medium',
      payload: '与 F20260814xxxx 冲突', status: 'pending', resolution: null, resolvedBy: null, resolvedAt: null,
      createdAt: '2026-08-26T10:00:00.000Z',
    });
  });

  it('参数缺失拒绝：signalId/status/resolution 各自必填', async () => {
    const tool = createResolveSignalTool(ctx, repo);
    expect((await tool.execute('t', {})).isError).toBe(true);
    expect((await tool.execute('t', { signalId: 'aaaaaaaa-1111-2222-3333-444444444444', status: 'bogus', resolution: 'x' })).isError).toBe(true);
    expect((await tool.execute('t', { signalId: 'aaaaaaaa-1111-2222-3333-444444444444', status: 'resolved', resolution: '  ' })).isError).toBe(true);
  });

  it('短 ID 前缀匹配裁决成功：pending → resolved + 留痕', async () => {
    const tool = createResolveSignalTool(ctx, repo);
    const res = await tool.execute('t', { signalId: 'aaaaaaaa', status: 'resolved', resolution: '当时否的是全量迁移，本次只迁搜索路径，不冲突' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('裁决完成');
    const ev = await repo.findById('aaaaaaaa-1111-2222-3333-444444444444');
    expect(ev?.status).toBe('resolved');
    expect(ev?.resolvedBy).toBe('otter-big');
    expect(ev?.resolution).toContain('全量迁移');
  });

  it('幂等：已裁决信号（完整 ID）返回现状不重复迁移', async () => {
    const tool = createResolveSignalTool(ctx, repo);
    await tool.execute('t', { signalId: 'aaaaaaaa', status: 'dismissed', resolution: 'x' });
    const res = await tool.execute('t', { signalId: 'aaaaaaaa-1111-2222-3333-444444444444', status: 'resolved', resolution: 'y' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('幂等');
    const ev = await repo.findById('aaaaaaaa-1111-2222-3333-444444444444');
    expect(ev?.status).toBe('dismissed'); // 第一次裁决生效
  });

  it('已裁决信号的短 ID 提示重查（短 ID 只搜 pending，避免撞车）', async () => {
    const tool = createResolveSignalTool(ctx, repo);
    await tool.execute('t', { signalId: 'aaaaaaaa', status: 'dismissed', resolution: 'x' });
    const res = await tool.execute('t', { signalId: 'aaaaaaaa', status: 'resolved', resolution: 'y' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('pending');
  });

  it('短 ID 前缀歧义拒绝', async () => {
    await repo.create({
      id: 'aaaaaaab-1111-2222-3333-444444444444', conversationId: 'conv-1', messageId: 'm1',
      fromOtterId: 'otter-small-1', targetOtterId: null, type: 'blocked', severity: 'low',
      payload: '卡住', status: 'pending', resolution: null, resolvedBy: null, resolvedAt: null,
      createdAt: '2026-08-26T10:01:00.000Z',
    });
    const tool = createResolveSignalTool(ctx, repo);
    const res = await tool.execute('t', { signalId: 'aaaaaaa', status: 'resolved', resolution: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('命中 2 条');
  });

  it('跨对话信号拒绝裁决（防御纵深）', async () => {
    await repo.create({
      id: 'bbbbbbbb-1111-2222-3333-444444444444', conversationId: 'conv-OTHER', messageId: 'm1',
      fromOtterId: 'otter-x', targetOtterId: null, type: 'objection', severity: 'low',
      payload: 'x', status: 'pending', resolution: null, resolvedBy: null, resolvedAt: null,
      createdAt: '2026-08-26T10:02:00.000Z',
    });
    const tool = createResolveSignalTool(ctx, repo);
    const res = await tool.execute('t', { signalId: 'bbbbbbbb', status: 'resolved', resolution: 'x' });
    expect(res.isError).toBe(true);
    // 注：短 ID 前缀搜索限定本对话，跨对话信号经完整 ID 访问时被 conversation 校验拒绝
    expect(res.content[0].text).toContain('无匹配');
  });
});
