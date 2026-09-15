/**
 * #927：halt 生命周期加固 + 信号老化扫描单测。
 *
 * 覆盖：
 * - haltRegistry 生命周期语义：endInvoke 清 pending（跨世代残留修复）、pending TTL 惰性过期、clear 解除
 * - unhalt_otter 工具：解除打标 + pending 落账 dismissed、reason 必填、目标解析
 * - SignalAgingWorker：pending >24h 落 medium healing、halt 类型不扫、已告警去重、repos 未注入静默跳过
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '@frameworks/db/schema';
import { SqliteSignalEventRepository } from '@frameworks/db/signal/sqlite-signal-repository';
import { SqliteHealingEventRepository } from '@frameworks/db/healing/sqlite-healing-event-repository';
import { haltRegistry, HALT_PENDING_TTL_MS, type HaltDirective } from '@usecases/signal/halt-registry';
import { createUnhaltOtterTool } from '@interface-adapters/agent-runtime/tools/signal-tools';
import { SignalAgingWorker, SIGNAL_AGING_THRESHOLD_MS } from '@usecases/signal/signal-aging-worker';
import type { SignalEvent } from '@entities/signal/signal-event';
import type { ToolContext } from '@usecases/ports/agent-tools';
import type { OtterToolClient } from '@usecases/ports/otter-tool-client';
import type { Logger } from '@usecases/ports/logger';

function makeDirective(overrides: Partial<HaltDirective> = {}): HaltDirective {
  return {
    id: 'sig-halt-1',
    targetOtterId: 'otter-small-1',
    fromOtterId: 'otter-big',
    fromOtterName: '大獭',
    conversationId: 'conv-1',
    reason: '方向反了，停手',
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCtx(): ToolContext {
  const client = {
    conversation: {
      participant: {
        getActive: async () => [
          { otterId: 'otter-big', otterName: '大獭', conversationId: 'conv-1', joinedAtTurnNumber: 1, status: 'active' },
          { otterId: 'otter-small-1', otterName: '开发獭-X', conversationId: 'conv-1', joinedAtTurnNumber: 2, status: 'active' },
        ],
      },
    },
  } as unknown as OtterToolClient;
  return { client, otterId: 'otter-big', conversationId: 'conv-1', currentMessageId: 'msg-1' };
}

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

describe('#927 haltRegistry 生命周期加固', () => {
  beforeEach(() => haltRegistry.resetForTest());

  it('endInvoke 清 pending：被 halt 獭合规响应（speak 报告+停止）后 invoke 结束，未送达指令不再残留', () => {
    haltRegistry.mark(makeDirective());
    // 被 halt 獭只 speak（豁免）未触发非 speak 调用，invoke 结束
    haltRegistry.endInvoke('otter-small-1');
    // 改派新 invoke：第一个工具调用不被拦（跨世代残留修复）
    expect(haltRegistry.takeForBlock('otter-small-1')).toHaveLength(0);
    expect(haltRegistry.isHalted('otter-small-1')).toBe(false);
  });

  it('endInvoke 只清目标獭：其他獭的打标不受影响', () => {
    haltRegistry.mark(makeDirective({ targetOtterId: 'otter-A', id: 'sig-a' }));
    haltRegistry.mark(makeDirective({ targetOtterId: 'otter-B', id: 'sig-b' }));
    haltRegistry.endInvoke('otter-A');
    expect(haltRegistry.takeForBlock('otter-B')).toHaveLength(1);
  });

  it('pending TTL 惰性过期：issuedAt 超 30min 的指令读取时被丢弃', () => {
    const stale = new Date(Date.now() - HALT_PENDING_TTL_MS - 1000).toISOString();
    haltRegistry.mark(makeDirective({ issuedAt: stale }));
    expect(haltRegistry.takeForBlock('otter-small-1')).toHaveLength(0);
    expect(haltRegistry.isHalted('otter-small-1')).toBe(false);
  });

  it('pending TTL 边界：恰好 30min 内的指令仍生效', () => {
    const fresh = new Date(Date.now() - HALT_PENDING_TTL_MS + 60_000).toISOString();
    haltRegistry.mark(makeDirective({ issuedAt: fresh }));
    expect(haltRegistry.takeForBlock('otter-small-1')).toHaveLength(1);
  });

  it('TTL 过期只影响 pending：active 中的指令不受影响（已送达持续 block 到 invoke 结束）', () => {
    haltRegistry.mark(makeDirective());
    // 已消费 → active
    expect(haltRegistry.takeForBlock('otter-small-1')).toHaveLength(1);
    // 时间流逝（模拟 issuedAt 已老，但指令已 active）
    haltRegistry['pending'].set('noop', [makeDirective({ targetOtterId: 'noop', issuedAt: new Date(Date.now() - HALT_PENDING_TTL_MS - 1000).toISOString() })]);
    expect(haltRegistry.takeForBlock('otter-small-1')).toHaveLength(1);
  });

  it('clear 解除：pending + active 全清，返回被清指令供台账落账', () => {
    haltRegistry.mark(makeDirective({ id: 'sig-p1' }));
    haltRegistry.mark(makeDirective({ targetOtterId: 'otter-A', id: 'sig-p2' }));
    // otter-small-1 消费一条进 active
    haltRegistry.takeForBlock('otter-small-1');

    const cleared = haltRegistry.clear('otter-small-1');
    expect(cleared.map(d => d.id)).toEqual([]); // pending 已被消费进 active，clear 返回 pending 残留
    expect(haltRegistry.takeForBlock('otter-small-1')).toHaveLength(0); // active 也清了
    expect(haltRegistry.isHalted('otter-small-1')).toBe(false);
    // 其他獭不受影响
    expect(haltRegistry.isHalted('otter-A')).toBe(true);
  });

  it('clear 未消费 pending：返回指令列表（供 dismissed 落账）', () => {
    haltRegistry.mark(makeDirective({ id: 'sig-unconsumed' }));
    const cleared = haltRegistry.clear('otter-small-1');
    expect(cleared.map(d => d.id)).toEqual(['sig-unconsumed']);
  });
});

describe('#927 unhalt_otter 工具', () => {
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
    const tool = createUnhaltOtterTool(ctx, repo);
    const res = await tool.execute('t1', { otterName: '开发獭-X' });
    expect(res.content[0].text).toContain('[错误]');
  });

  it('解除未消费 pending：打标清除 + signal_events 落账 dismissed', async () => {
    // 先 halt 打标 + 落账
    const event: SignalEvent = {
      id: 'sig-halt-1', conversationId: 'conv-1', messageId: 'msg-1',
      fromOtterId: 'otter-big', targetOtterId: 'otter-small-1',
      type: 'halt', severity: 'high', payload: '停手', status: 'pending',
      resolution: null, resolvedBy: null, resolvedAt: null, createdAt: new Date().toISOString(),
    };
    await repo.create(event);
    haltRegistry.mark(makeDirective({ id: 'sig-halt-1' }));
    expect(haltRegistry.isHalted('otter-small-1')).toBe(true);

    const tool = createUnhaltOtterTool(ctx, repo, mockLogger);
    const res = await tool.execute('t2', { otterName: '开发獭-X', reason: 'halt 错了目标，撤回' });
    expect(res.content[0].text).toContain('已解除');
    expect(res.content[0].text).toContain('1 条');

    expect(haltRegistry.isHalted('otter-small-1')).toBe(false);
    // 落账迁移 pending → dismissed
    await vi.waitFor(async () => {
      const stored = await repo.findById('sig-halt-1');
      expect(stored?.status).toBe('dismissed');
      expect(stored?.resolution).toContain('halt 错了目标');
    });
  });

  it('无生效打标时解除：幂等成功，不误报', async () => {
    const tool = createUnhaltOtterTool(ctx, repo, mockLogger);
    const res = await tool.execute('t3', { otterName: '开发獭-X', reason: '例行清理' });
    expect(res.content[0].text).toContain('已解除');
    expect(res.content[0].text).toContain('0 条');
  });

  it('目标不存在给出可操作错误', async () => {
    const tool = createUnhaltOtterTool(ctx, repo, mockLogger);
    const res = await tool.execute('t4', { otterName: '幽灵獭', reason: 'x'.repeat(10) });
    expect(res.content[0].text).toContain('找不到');
  });
});

describe('#927 SignalAgingWorker', () => {
  let db: Database.Database;
  let signalRepo: SqliteSignalEventRepository;
  let healingRepo: SqliteHealingEventRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    signalRepo = new SqliteSignalEventRepository(db);
    healingRepo = new SqliteHealingEventRepository(db);
  });

  function makeSignal(overrides: Partial<SignalEvent> = {}): SignalEvent {
    return {
      id: `sig-${Math.random().toString(36).slice(2, 8)}`,
      conversationId: 'conv-1', messageId: 'msg-1',
      fromOtterId: 'otter-small-1', targetOtterId: null,
      type: 'blocked', severity: 'medium', payload: '卡住了需要裁决',
      status: 'pending', resolution: null, resolvedBy: null, resolvedAt: null,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('pending blocked 悬置 >24h → 落 medium healing 告警', async () => {
    const old = new Date(Date.now() - SIGNAL_AGING_THRESHOLD_MS - 3600_000).toISOString();
    await signalRepo.create(makeSignal({ createdAt: old }));
    const worker = new SignalAgingWorker(() => signalRepo, () => healingRepo, mockLogger, 3_600_000);

    const result = await worker.scanOnce();
    expect(result.agedCount).toBe(1);
    expect(result.alertsCreated).toBe(1);

    const open = await healingRepo.findOpen();
    expect(open).toHaveLength(1);
    expect(open[0].severity).toBe('medium');
    expect((open[0].context as { signalId?: string })?.signalId).toBeDefined();
  });

  it('pending <24h 不告警', async () => {
    await signalRepo.create(makeSignal({ createdAt: new Date(Date.now() - 3600_000).toISOString() }));
    const worker = new SignalAgingWorker(() => signalRepo, () => healingRepo, mockLogger);
    const result = await worker.scanOnce();
    expect(result.agedCount).toBe(0);
    expect(result.alertsCreated).toBe(0);
  });

  it('halt 类型不扫（无待裁决事项，首次注入即 resolved）', async () => {
    const old = new Date(Date.now() - SIGNAL_AGING_THRESHOLD_MS * 2).toISOString();
    await signalRepo.create(makeSignal({ type: 'halt', status: 'pending', createdAt: old }));
    const worker = new SignalAgingWorker(() => signalRepo, () => healingRepo, mockLogger);
    const result = await worker.scanOnce();
    expect(result.agedCount).toBe(0);
  });

  it('已 resolved 的信号不扫', async () => {
    const old = new Date(Date.now() - SIGNAL_AGING_THRESHOLD_MS * 2).toISOString();
    await signalRepo.create(makeSignal({ status: 'resolved', createdAt: old }));
    const worker = new SignalAgingWorker(() => signalRepo, () => healingRepo, mockLogger);
    const result = await worker.scanOnce();
    expect(result.agedCount).toBe(0);
  });

  it('去重：同一 signalId 已有 open 老化告警 → 不重复落账', async () => {
    const old = new Date(Date.now() - SIGNAL_AGING_THRESHOLD_MS - 3600_000).toISOString();
    const sig = makeSignal({ id: 'sig-dedup', createdAt: old });
    await signalRepo.create(sig);

    const worker = new SignalAgingWorker(() => signalRepo, () => healingRepo, mockLogger);
    const r1 = await worker.scanOnce();
    expect(r1.alertsCreated).toBe(1);
    const r2 = await worker.scanOnce();
    expect(r2.agedCount).toBe(1); // 仍超时
    expect(r2.alertsCreated).toBe(0); // 但不重复告警
    const open = await healingRepo.findOpen();
    expect(open).toHaveLength(1);
  });

  it('repos 未注入（undefined）→ 静默跳过不抛错', async () => {
    const worker = new SignalAgingWorker(() => undefined, () => undefined, mockLogger);
    const result = await worker.scanOnce();
    expect(result.agedCount).toBe(0);
    expect(result.alertsCreated).toBe(0);
  });

  it('多条悬置一次性全部告警（去重各自独立）', async () => {
    const old = new Date(Date.now() - SIGNAL_AGING_THRESHOLD_MS - 3600_000).toISOString();
    await signalRepo.create(makeSignal({ type: 'objection', createdAt: old }));
    await signalRepo.create(makeSignal({ type: 'blocked', createdAt: old }));
    const worker = new SignalAgingWorker(() => signalRepo, () => healingRepo, mockLogger);
    const result = await worker.scanOnce();
    expect(result.agedCount).toBe(2);
    expect(result.alertsCreated).toBe(2);
  });
});
