/**
 * #1227：信号裁决提醒链路测试（M1：当场处理可见性）。
 *
 * 链路：小獭 speak 嵌 <signal> → interceptSignalReport 落账 + signalAlertRegistry.register
 * → 大獭下一轮 invoke 头部注入（renderSignalAlerts）→ resolve_signal 裁决 → dismiss 注销。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { signalAlertRegistry, renderSignalAlerts } from '@usecases/signal/signal-alert-registry';
import { interceptSignalReport, createResolveSignalTool } from '@interface-adapters/agent-runtime/tools/signal-tools';
import { SqliteSignalEventRepository } from '@frameworks/db/signal/sqlite-signal-repository';
import { initSchema } from '@frameworks/db/schema';
import Database from 'better-sqlite3';
import type { ToolContext } from '@usecases/ports/agent-tools';

function makeCtx(conversationId = 'conv-1', otterId = 'otter-small-1'): ToolContext {
  const client = {
    conversation: {
      participant: {
        getActive: async () => [
          { otterId: 'otter-big', otterName: '大獭', conversationId, joinedAtTurnNumber: 1, status: 'active' },
          { otterId: otterId, otterName: '开发獭-X', conversationId, joinedAtTurnNumber: 2, status: 'active' },
        ],
      },
    },
  };
  return { client, otterId, conversationId, currentMessageId: 'msg-1' } as unknown as ToolContext;
}

describe('signalAlertRegistry（#1227 M1）', () => {
  beforeEach(() => signalAlertRegistry.resetForTest());

  it('register → takeAll 送达即删', () => {
    signalAlertRegistry.register({ signalId: 'id-1', conversationId: 'c1', fromOtterId: 'o1', signalType: 'objection', severity: 'medium', payloadPreview: 'x', createdAt: 'now' });
    expect(signalAlertRegistry.takeAll('c1')).toHaveLength(1);
    expect(signalAlertRegistry.takeAll('c1')).toHaveLength(0); // 消费即删
  });

  it('dismiss 注销指定信号（裁决联动）', () => {
    signalAlertRegistry.register({ signalId: 'id-1', conversationId: 'c1', fromOtterId: 'o1', signalType: 'objection', severity: 'low', payloadPreview: 'x', createdAt: 'now' });
    signalAlertRegistry.register({ signalId: 'id-2', conversationId: 'c1', fromOtterId: 'o1', signalType: 'blocked', severity: 'high', payloadPreview: 'y', createdAt: 'now' });
    signalAlertRegistry.dismiss('id-1');
    const rest = signalAlertRegistry.takeAll('c1');
    expect(rest).toHaveLength(1);
    expect(rest[0]!.signalId).toBe('id-2');
  });

  it('积压上限 20（防滥用）', () => {
    for (let i = 0; i < 25; i++) {
      signalAlertRegistry.register({ signalId: `id-${i}`, conversationId: 'c1', fromOtterId: 'o1', signalType: 'objection', severity: 'low', payloadPreview: 'x', createdAt: 'now' });
    }
    expect(signalAlertRegistry.takeAll('c1')).toHaveLength(20);
  });

  it('跨对话隔离（c1 的提醒不会在 c2 冒出）', () => {
    signalAlertRegistry.register({ signalId: 'id-1', conversationId: 'c1', fromOtterId: 'o1', signalType: 'objection', severity: 'low', payloadPreview: 'x', createdAt: 'now' });
    expect(signalAlertRegistry.takeAll('c2')).toHaveLength(0);
  });

  it('renderSignalAlerts：短 ID + 处置指引', () => {
    const text = renderSignalAlerts([
      { signalId: 'aaaaaaaa-1111-2222-3333-444444444444', conversationId: 'c1', fromOtterId: 'bbbbbbbb-1111', signalType: 'objection', severity: 'medium', payloadPreview: '与 F20260901xxxx 冲突', createdAt: 'now' },
    ]);
    expect(text).toContain('aaaaaaaa');
    expect(text).toContain('resolve_signal');
    expect(text).toContain('不得悬置');
  });
});

describe('落账→提醒 闭环（interceptSignalReport 联动）', () => {
  let db: Database.Database;
  let repo: SqliteSignalEventRepository;

  beforeEach(async () => {
    signalAlertRegistry.resetForTest();
    db = new Database(':memory:');
    initSchema(db);
    repo = new SqliteSignalEventRepository(db);
  });

  it('小獭嵌 signal 落账后 registry 有提醒（fire-and-forget 落库完成后）', async () => {
    const ctx = makeCtx();
    await interceptSignalReport(
      '汇报进度 <signal type="objection" severity="medium">派工方向与 F20260901xxxx 冲突</signal>',
      ctx,
      repo,
    );
    // fire-and-forget：等微任务队列 flush
    await new Promise(r => setTimeout(r, 20));
    const alerts = signalAlertRegistry.takeAll('conv-1');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.signalType).toBe('objection');
    expect(alerts[0]!.payloadPreview).toContain('派工方向');
  });

  it('大獭 resolve 后提醒注销（台账-提醒联动）', async () => {
    const smallCtx = makeCtx();
    await interceptSignalReport(
      '<signal type="blocked" severity="high">卡住需要资源</signal>',
      smallCtx,
      repo,
    );
    await new Promise(r => setTimeout(r, 20));
    expect(signalAlertRegistry.takeAll('conv-1')).toHaveLength(1);

    // 重新登记（上面 takeAll 已消费）——模拟下一轮注入前的状态
    const alerts = signalAlertRegistry.takeAll('conv-1');
    expect(alerts).toHaveLength(0); // 已消费

    // 落库的信号在大獭裁决时注销应无副作用（幂等）
    const events = await repo.findByConversation('conv-1', { status: 'pending' }, 10);
    expect(events).toHaveLength(1);
    signalAlertRegistry.dismiss(events[0]!.id); // 无提醒在队——no-op
    const bigCtx = makeCtx('conv-1', 'otter-big');
    const tool = createResolveSignalTool(bigCtx, repo);
    const res = await tool.execute('t', { signalId: events[0]!.id.slice(0, 8), status: 'resolved', resolution: '资源已给' });
    expect(res.isError).toBeUndefined();
  });
});
