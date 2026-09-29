/**
 * #1052：triage_signal 工具层 batch_bind 单测（真 sqlite + 真 SignalRepository）。
 *
 * 覆盖：批量路径分流（无 signalId）、issueNumber 必填校验、filter 至少一个校验、
 * dryRun、truncated、JSON 响应结构、单条三动作回归（改 required 后不破原路径）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '@frameworks/db/schema';
import { migrateDatabase } from '@frameworks/db/migration';
import { SignalRepository } from '@usecases/health/signal-repository';
import { createTriageSignalTool } from '@interface-adapters/agent-runtime/tools/rhi-signal-tools';
import type { ToolContext } from '@usecases/ports/agent-tools';

const mockCtx = {
  otterId: 'otter-1', conversationId: 'conv-1', currentMessageId: 'msg-1',
  client: {} as Record<string, unknown>,
} as unknown as ToolContext;

describe('triage_signal batch_bind 工具层（真 sqlite）', () => {
  let db: Database.Database;
  let repo: SignalRepository;
  let tool: ReturnType<typeof createTriageSignalTool>;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    migrateDatabase(db, console as never);
    repo = new SignalRepository(db);
    tool = createTriageSignalTool(mockCtx, repo);
  });
  afterEach(() => { db.close(); });

  const seed = (signalType: string, severity: string) =>
    repo.upsert({
      signalType, severity, featureId: null, filePath: `src/${signalType}-${Math.random().toString(36).slice(2, 6)}.ts`,
      evidence: 'x', suggestedAction: null,
    });

  it('batch_bind 批量归口：JSON 响应含 matched/bound/truncated/totalMatched', async () => {
    seed('bug_recurrence', 'critical');
    seed('bug_recurrence', 'warning');
    const r = await tool.execute('call-1', {
      action: 'batch_bind', issueNumber: 1052,
      filterSignalType: 'bug_recurrence', note: '同根因批量归口',
    });
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.matched).toBe(2);
    expect(body.bound).toBe(2);
    expect(body.truncated).toBe(false);
    expect(body.totalMatched).toBe(2);
    expect(body.issueNumber).toBe(1052);
    const unassigned = repo.findByTriageStatus('null');
    expect(unassigned).toHaveLength(0);
  });

  it('issueNumber 缺失报错（批量路径独立校验）', async () => {
    const r = await tool.execute('call-1', { action: 'batch_bind', filterSignalType: 'bug_recurrence' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('issueNumber 必填');
  });

  it('filter 全缺报错——全量绑定属异质归口，拦在入口', async () => {
    const r = await tool.execute('call-1', { action: 'batch_bind', issueNumber: 1052 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('至少需要一个过滤条件');
  });

  it('dryRun 返回匹配数不动库', async () => {
    seed('bug_recurrence', 'critical');
    const r = await tool.execute('call-1', {
      action: 'batch_bind', issueNumber: 1052, filterSignalType: 'bug_recurrence', dryRun: true,
    });
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.dryRun).toBe(true);
    expect(body.matched).toBe(1);
    expect(repo.findByTriageStatus('null')).toHaveLength(1);
  });

  it('单批 100 截断 + 续批收敛', async () => {
    for (let i = 0; i < 130; i++) seed('bug_recurrence', 'critical');
    const r1 = await tool.execute('call-1', {
      action: 'batch_bind', issueNumber: 1052, filterSignalType: 'bug_recurrence',
    });
    const b1 = JSON.parse(r1.content[0].text);
    expect(b1.matched).toBe(100);
    expect(b1.truncated).toBe(true);
    expect(b1.totalMatched).toBe(130);
    const r2 = await tool.execute('call-2', {
      action: 'batch_bind', issueNumber: 1052, filterSignalType: 'bug_recurrence',
    });
    const b2 = JSON.parse(r2.content[0].text);
    expect(b2.matched).toBe(30);
    expect(b2.truncated).toBe(false);
  });

  it('filterSeverity 匹配多个类型（按严重度跨类型归口）', async () => {
    seed('bug_recurrence', 'critical');
    const other = seed('stale_pr_merge', 'critical');
    const r = await tool.execute('call-1', {
      action: 'batch_bind', issueNumber: 1052, filterSeverity: 'critical',
    });
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.matched).toBe(2);
    expect(repo.findById(other.id)!.triage_status).toBe('triaged'); // severity 过滤跨类型命中
  });

  it('单条三动作回归：改 required 后原路径不破', async () => {
    const s = seed('bug_recurrence', 'critical');
    // bind_issue
    const rb = await tool.execute('c1', { action: 'bind_issue', signalId: s.id, issueNumber: 9 });
    expect(rb.isError).toBeUndefined();
    expect(rb.content[0].text).toContain('triage 完成');
    // 单条路径 signalId 缺失仍报错引导
    const rbErr = await tool.execute('c2', { action: 'bind_issue', issueNumber: 9 });
    expect(rbErr.isError).toBe(true);
    expect(rbErr.content[0].text).toContain('signalId 必填');
    // in_progress 前置校验
    const rp = await tool.execute('c3', { action: 'in_progress', signalId: s.id });
    expect(rp.isError).toBeUndefined();
    expect(rp.content[0].text).toContain('in_progress');
  });
});
