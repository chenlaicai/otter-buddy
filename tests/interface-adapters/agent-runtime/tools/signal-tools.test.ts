/**
 * F20260826mwrd C1：halt_otter / query_signals 工具单测。
 *
 * 覆盖：参数校验（reason 必填/目标解析失败）、自我 halt 拒绝、打标+落账联动、
 * 台账查询过滤。mock ToolContext（client.conversation.participant.getActive）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '@frameworks/db/schema';
import { SqliteSignalEventRepository } from '@frameworks/db/signal/sqlite-signal-repository';
import { createHaltOtterTool, createQuerySignalsTool } from '@interface-adapters/agent-runtime/tools/signal-tools';
import { haltRegistry } from '@usecases/signal/halt-registry';
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
