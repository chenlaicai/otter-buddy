/**
 * #1271（F20261008hbbd）：manage_healing_events batch_bind 工具层 + batchBindIssue 仓储层测试。
 *
 * 覆盖矩阵：
 * - 工具层：issueNumber 必填校验 / 防异质归口（至少一个过滤条件）/ dryRun 预览 /
 *   真实执行（bound + truncated）/ 只作用未归口 open / bind 后状态保持 open（bind≠resolve）
 * - 高价值语义回归：已归口 high 过批量闸（收尾环）/ 未归口 high 仍拦 batch_resolve
 * - 仓储层：ruleId 过滤（json_valid 防御非法 context）/ boundIssue 过滤（null=未归口面）/
 *   幂等面（二次 bind 同 filter 不换绑——boundIssue:null 强制）
 * - 迁移：ensureHealingEventsBoundIssueColumns 幂等（PRAGMA 检测 + 索引补建）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from '../../../helpers/db';
import { SqliteHealingEventRepository } from '@frameworks/db/healing/sqlite-healing-event-repository';
import { initSchema } from '@frameworks/db/schema';
import { migrateDatabase } from '@frameworks/db/migration';
import { createManageHealingEventsTool } from '@interface-adapters/agent-runtime/tools/healing-tools';
import type { ToolContext } from '@usecases/ports/agent-tools';
import type { HealingEvent } from '@entities/healing/healing-event';

/** 同 migration.test.ts 的 createTestLogger（静默 logger，仅验证不炸） */
function createTestLogger() {
  return {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  } as unknown as Parameters<typeof migrateDatabase>[1];
}

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

describe('manage_healing_events batch_bind 工具层', () => {
  let db: Database.Database;
  let repo: SqliteHealingEventRepository;
  let tool: ReturnType<typeof createManageHealingEventsTool>;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteHealingEventRepository(db);
    tool = createManageHealingEventsTool(mockCtx, repo);
  });
  afterEach(() => { db.close(); });

  it('issueNumber 缺失/非法时拒绝', async () => {
    const r1 = await tool.execute('c1', { action: 'batch_bind', filterErrorType: 'tool_failure' });
    expect(r1.isError).toBe(true);
    const r2 = await tool.execute('c1', { action: 'batch_bind', issueNumber: -3, filterErrorType: 'tool_failure' });
    expect(r2.isError).toBe(true);
    const r3 = await tool.execute('c1', { action: 'batch_bind', issueNumber: 'abc', filterErrorType: 'tool_failure' });
    expect(r3.isError).toBe(true);
  });

  it('无任何过滤条件时拒绝（防异质归口）', async () => {
    const r = await tool.execute('c1', { action: 'batch_bind', issueNumber: 999 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('至少一个过滤条件');
  });

  it('dryRun 只返回匹配数不写列', async () => {
    await repo.create(seedEvent({ id: 'e1', errorType: 'guard_intercept', context: { ruleId: 'r-x' } }));
    await repo.create(seedEvent({ id: 'e2', errorType: 'guard_intercept', context: { ruleId: 'r-x' } }));
    const r = await tool.execute('c1', {
      action: 'batch_bind', dryRun: true, issueNumber: 42,
      filterErrorType: 'guard_intercept', filterRuleId: 'r-x',
    });
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.dryRun).toBe(true);
    expect(body.matched).toBe(2);
    const evt = await repo.findById('e1');
    expect(evt?.boundIssue ?? null).toBeNull();
  });

  it('真实执行：bound 计数 + boundIds + 状态保持 open（bind≠resolve）', async () => {
    await repo.create(seedEvent({ id: 'e1', errorType: 'guard_intercept', context: { ruleId: 'r-x' } }));
    await repo.create(seedEvent({ id: 'e2', errorType: 'guard_intercept', context: { ruleId: 'r-x' } }));
    await repo.create(seedEvent({ id: 'e3', errorType: 'guard_intercept', context: { ruleId: 'r-y' } }));
    const r = await tool.execute('c1', {
      action: 'batch_bind', issueNumber: 42,
      filterErrorType: 'guard_intercept', filterRuleId: 'r-x',
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.bound).toBe(2);
    expect(body.boundIds.sort()).toEqual(['e1', 'e2']);
    // bind≠resolve：状态保持 open，resolution 仍空
    for (const id of ['e1', 'e2']) {
      const evt = await repo.findById(id);
      expect(evt?.status).toBe('open');
      expect(evt?.boundIssue).toBe(42);
      expect(evt?.boundAt).toBeTruthy();
      expect(evt?.resolution).toBeNull();
    }
    // r-y 事件族不受影响
    const e3 = await repo.findById('e3');
    expect(e3?.boundIssue ?? null).toBeNull();
  });

  it('已归口事件不参与二次 bind（强制未归口面，防换绑）', async () => {
    await repo.create(seedEvent({ id: 'e1', errorType: 'guard_intercept', context: { ruleId: 'r-x' } }));
    await tool.execute('c1', {
      action: 'batch_bind', issueNumber: 42,
      filterErrorType: 'guard_intercept', filterRuleId: 'r-x',
    });
    // 同 filter 换 issueNumber 再 bind——matched 0（已归口面被排除）
    const r = await tool.execute('c1', {
      action: 'batch_bind', issueNumber: 77,
      filterErrorType: 'guard_intercept', filterRuleId: 'r-x',
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.bound).toBe(0);
    const evt = await repo.findById('e1');
    expect(evt?.boundIssue).toBe(42); // 未被换绑
  });

  it('resolved/dismissed 事件不参与 bind（只作用 open）', async () => {
    await repo.create(seedEvent({ id: 'e1', errorType: 'guard_intercept', context: { ruleId: 'r-x' } }));
    await repo.resolve('e1', { action: 'no_action', decidedBy: 'agent', decidedAt: new Date().toISOString(), notes: '' });
    const r = await tool.execute('c1', {
      action: 'batch_bind', issueNumber: 42,
      filterErrorType: 'guard_intercept', filterRuleId: 'r-x',
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.bound).toBe(0);
  });

  it('>100 条匹配时 truncated=true（分批提示）', async () => {
    for (let i = 0; i < 150; i++) {
      await repo.create(seedEvent({ id: 'e-' + i, errorType: 'guard_intercept', context: { ruleId: 'r-x' } }));
    }
    const r = await tool.execute('c1', {
      action: 'batch_bind', issueNumber: 42,
      filterErrorType: 'guard_intercept', filterRuleId: 'r-x',
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.bound).toBe(100);
    expect(body.truncated).toBe(true);
    expect(body.totalMatched).toBe(150);
  });

  it('r1-A1：batch_resolve dryRun 的 matched/truncated 与真实执行同语义', async () => {
    for (let i = 0; i < 150; i++) {
      await repo.create(seedEvent({ id: 'e-' + i, errorType: 'tool_failure', severity: 'low', context: null }));
    }
    const r = await tool.execute('c1', { action: 'batch_resolve', dryRun: true, filterErrorType: 'tool_failure' });
    const body = JSON.parse(r.content[0].text);
    expect(body.dryRun).toBe(true);
    expect(body.matched).toBe(100); // 单批上限而非全量 count——与真实执行对齐
    // 仓储层直验同语义
    const raw = await repo.batchResolveByFilter(
      { errorType: 'tool_failure' },
      { action: 'no_action', decidedBy: 'agent', decidedAt: new Date().toISOString(), notes: '' },
      { dryRun: true },
    );
    expect(raw.truncated).toBe(true);
    expect(raw.totalMatched).toBe(150);
    expect(raw.matched).toBe(100);
  });

  it('high 事件可 batch_bind（不设闸——归口是结构化认领，恰是 high 推荐去向）', async () => {
    await repo.create(seedEvent({ id: 'e1', errorType: 'guard_intercept', severity: 'high', context: { ruleId: 'r-x' } }));
    await repo.create(seedEvent({ id: 'e2', errorType: 'guard_intercept', severity: 'high', context: { ruleId: 'r-x' } }));
    const r = await tool.execute('c1', {
      action: 'batch_bind', issueNumber: 42,
      filterErrorType: 'guard_intercept', filterRuleId: 'r-x',
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.bound).toBe(2);
  });

  it('收尾环：已归口 high 可 batch_resolve（闸豁免），未归口 high 仍拦', async () => {
    await repo.create(seedEvent({ id: 'h1', errorType: 'guard_intercept', severity: 'high', context: { ruleId: 'r-x' } }));
    await repo.create(seedEvent({ id: 'h2', errorType: 'guard_intercept', severity: 'high', context: { ruleId: 'r-x' } }));
    await repo.create(seedEvent({ id: 'h3', errorType: 'guard_intercept', severity: 'high', context: { ruleId: 'r-z' } }));

    // 未归口 high：批量闸仍然拦（本体语义不变）
    const blocked = await tool.execute('c1', { action: 'batch_resolve', filterErrorType: 'guard_intercept' });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toContain('high');

    // 归口 r-x 族到 issue 42
    await tool.execute('c1', {
      action: 'batch_bind', issueNumber: 42,
      filterErrorType: 'guard_intercept', filterRuleId: 'r-x',
    });
    // 收窄到 issue 42 面：h1/h2 已归口可批量收尾；h3 未归口仍被闸拦
    const stillBlocked = await tool.execute('c1', { action: 'batch_resolve', filterErrorType: 'guard_intercept', filterBoundIssue: 42 });
    // h3 不匹配 filterBoundIssue=42，探测面只含已归口 h1/h2 → 放行
    const body = JSON.parse(stillBlocked.content[0].text);
    expect(body.resolved).toBe(2);
    for (const id of ['h1', 'h2']) {
      const evt = await repo.findById(id);
      expect(evt?.status).toBe('resolved');
    }
    const h3 = await repo.findById('h3');
    expect(h3?.status).toBe('open'); // 未归口 high 不被误伤
  });

  it('r1-S1 场景 X：不传 filterBoundIssue 的普通批量不终结已归口事件（更新面隔离）', async () => {
    // PoC 复刻：h1（high，已归口 #42，open）+ l1（low）→ 普通 batch_resolve
    await repo.create(seedEvent({ id: 'h1', errorType: 'tool_failure', severity: 'high', context: null }));
    await repo.create(seedEvent({ id: 'l1', errorType: 'tool_failure', severity: 'low', context: null }));
    await repo.batchBindIssue({ errorType: 'tool_failure' }, 42); // h1/l1 都归口

    // 普通「清理残留」型批处置（不传 filterBoundIssue）——修复后更新面限定未归口域
    const r = await tool.execute('c1', { action: 'batch_resolve', filterErrorType: 'tool_failure' });
    const body = JSON.parse(r.content[0].text);
    expect(body.resolved).toBe(0); // 已归口事件不被顺带终结
    const h1 = await repo.findById('h1');
    expect(h1?.status).toBe('open'); // bind≠resolve 生命周期保持
    expect(h1?.boundIssue).toBe(42);
  });
});

describe('batchBindIssue 仓储层', () => {
  let db: Database.Database;
  let repo: SqliteHealingEventRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteHealingEventRepository(db);
  });
  afterEach(() => { db.close(); });

  it('ruleId 过滤只命中同指纹事件族，非法 context 行不炸', async () => {
    await repo.create(seedEvent({ id: 'e1', errorType: 'guard_intercept', context: { ruleId: 'r-x' } }));
    await repo.create(seedEvent({ id: 'e2', errorType: 'guard_intercept', context: { ruleId: 'r-y' } }));
    // 非 guard 事件 context 无 ruleId
    await repo.create(seedEvent({ id: 'e3', errorType: 'tool_failure', context: { foo: 1 } }));
    // 直接写一行非法 JSON context（模拟历史脏数据——json_valid 防御面）
    db.prepare(
      `INSERT INTO healing_events (id, message_id, conversation_id, otter_id, error_type, severity, description, suggestion, context, status, created_at)
       VALUES ('dirty-1', 'm', 'c', 'o', 'guard_intercept', 'low', 'd', '', '{not-json', 'open', ?)`,
    ).run(new Date().toISOString());

    const r = await repo.batchBindIssue({ errorType: 'guard_intercept', ruleId: 'r-x' }, 42);
    expect(r.bound).toBe(1);
    expect(r.boundIds).toEqual(['e1']);
  });

  it('boundIssue=null 过滤 = 未归口面（countByFilter 同口径）', async () => {
    await repo.create(seedEvent({ id: 'e1', errorType: 'tool_failure' }));
    await repo.batchBindIssue({ errorType: 'tool_failure' }, 42);
    const cntUnbound = await repo.countByFilter({ errorType: 'tool_failure', boundIssue: null });
    const cntBound = await repo.countByFilter({ errorType: 'tool_failure', boundIssue: 42 });
    expect(cntUnbound).toBe(0);
    expect(cntBound).toBe(1);
  });

  it('filterCreatedBefore/After 与 ruleId 组合（AND 语义）', async () => {
    const old = new Date(Date.now() - 10 * 86400000).toISOString();
    await repo.create(seedEvent({ id: 'old', errorType: 'guard_intercept', context: { ruleId: 'r-x' }, createdAt: old }));
    await repo.create(seedEvent({ id: 'new', errorType: 'guard_intercept', context: { ruleId: 'r-x' } }));
    const r = await repo.batchBindIssue(
      { errorType: 'guard_intercept', ruleId: 'r-x', createdBefore: new Date(Date.now() - 5 * 86400000).toISOString() },
      42,
    );
    expect(r.boundIds).toEqual(['old']);
  });

  it('batchResolveByFilter 按 boundIssue 收尾（修复合入后的终结环）', async () => {
    await repo.create(seedEvent({ id: 'e1', errorType: 'guard_intercept', context: { ruleId: 'r-x' } }));
    await repo.create(seedEvent({ id: 'e2', errorType: 'guard_intercept', context: { ruleId: 'r-x' } }));
    await repo.create(seedEvent({ id: 'e3', errorType: 'tool_failure' }));
    await repo.batchBindIssue({ errorType: 'guard_intercept', ruleId: 'r-x' }, 42);

    const r = await repo.batchResolveByFilter(
      { boundIssue: 42 },
      { action: 'tool_fixed', decidedBy: 'agent', decidedAt: new Date().toISOString(), notes: 'PR #xxx merged' },
    );
    expect(r.resolved).toBe(2);
    expect(r.resolvedIds.sort()).toEqual(['e1', 'e2']);
    // e3 未归口不受影响
    const e3 = await repo.findById('e3');
    expect(e3?.status).toBe('open');
  });
});

describe('#1271 存量库迁移（ensureHealingEventsBoundIssueColumns）', () => {
  it('旧库（无 bound_issue 列）迁移后可 bind + 幂等重跑', async () => {
    const db = new Database(':memory:');
    try {
      initSchema(db);
      // 模拟早于 #1271 时代的存量库：DROP 掉归口链两列（同 introduced_by_pr 迁移测试先例）。
      // 先 DROP INDEX：SQLite DROP COLUMN 遇到被索引引用的列会报错
      db.exec('DROP INDEX IF EXISTS idx_healing_events_bound_issue');
      db.exec('ALTER TABLE healing_events DROP COLUMN bound_issue');
      db.exec('ALTER TABLE healing_events DROP COLUMN bound_at');
      const beforeCols = db.prepare('PRAGMA table_info(healing_events)').all() as Array<{ name: string }>;
      expect(beforeCols.some(c => c.name === 'bound_issue')).toBe(false);
      // 留一行旧形态数据（context 带 ruleId，验证迁移后可被 bind）
      db.prepare(
        `INSERT INTO healing_events (id, message_id, conversation_id, otter_id, error_type, severity, description, suggestion, context, status, created_at) VALUES ('legacy-1', 'm', 'c', 'o', 'guard_intercept', 'low', 'd', '', ?, 'open', ?)`,
      ).run(JSON.stringify({ ruleId: 'r-x' }), new Date().toISOString());
      migrateDatabase(db, createTestLogger());
      const cols = db.prepare('PRAGMA table_info(healing_events)').all() as Array<{ name: string }>;
      expect(cols.some(c => c.name === 'bound_issue')).toBe(true);
      expect(cols.some(c => c.name === 'bound_at')).toBe(true);
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_healing_events_bound_issue'").get();
      expect(idx).toBeTruthy();
      // 幂等：重跑不炸
      expect(() => migrateDatabase(db, createTestLogger())).not.toThrow();
      // 迁移后的旧库行可被 bind（仓储真实链路）
      const repo = new SqliteHealingEventRepository(db);
      const r = await repo.batchBindIssue({ errorType: 'guard_intercept', ruleId: 'r-x' }, 42);
      expect(r.bound).toBe(1);
      expect(r.boundIds).toEqual(['legacy-1']);
      const evt = await repo.findById('legacy-1');
      expect(evt?.boundIssue).toBe(42);
    } finally {
      db.close();
    }
  });
});
