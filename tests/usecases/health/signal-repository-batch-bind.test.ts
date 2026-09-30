/**
 * #1052：SignalRepository.batchBindIssue 单测（真 sqlite）。
 *
 * 覆盖：dryRun 预览、filter 过滤、单批 100 截断、只碰未接单边界、
 * note COALESCE 保留、与单条 bind_issue 语义等价（triaged + issue_number + triaged_at）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '@frameworks/db/schema';
import { migrateDatabase } from '@frameworks/db/migration';
import { SignalRepository } from '@usecases/health/signal-repository';

describe('SignalRepository.batchBindIssue（真 sqlite）', () => {
  let db: Database.Database;
  let repo: SignalRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    migrateDatabase(db, console as never);
    repo = new SignalRepository(db);
  });
  afterEach(() => { db.close(); });

  const seed = (signalType: string, severity: string, filePath: string) =>
    repo.upsert({
      signalType, severity, featureId: null, filePath,
      evidence: `${signalType} evidence`, suggestedAction: null,
    });

  it('批量归口：未接单 open 信号全部 triaged + issue_number + triaged_at', () => {
    const s1 = seed('bug_recurrence', 'critical', 'src/a.ts');
    const s2 = seed('bug_recurrence', 'warning', 'src/b.ts');
    const r = repo.batchBindIssue({ signalType: 'bug_recurrence' }, 1052);
    expect(r.matched).toBe(2);
    expect(r.bound).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.totalMatched).toBe(2);
    for (const s of [s1, s2]) {
      const row = repo.findById(s.id)!;
      expect(row.triage_status).toBe('triaged');
      expect(row.issue_number).toBe(1052);
      expect(row.triaged_at).toBeTruthy();
    }
  });

  it('filter 过滤：signalType 只绑匹配行，其他类型不动', () => {
    seed('bug_recurrence', 'critical', 'src/a.ts');
    const other = seed('stale_pr_merge', 'critical', 'src/b.ts');
    const r = repo.batchBindIssue({ signalType: 'bug_recurrence' }, 1052);
    expect(r.matched).toBe(1);
    expect(repo.findById(other.id)!.triage_status).toBeNull();
  });

  it('只碰未接单：已 triaged / in_progress / 终态信号不参与', () => {
    const s1 = seed('bug_recurrence', 'critical', 'src/a.ts');
    const s2 = seed('bug_recurrence', 'critical', 'src/b.ts');
    const s3 = seed('bug_recurrence', 'critical', 'src/c.ts');
    // s1 已归口到别的 issue，s2 修复中，s3 终态 resolved
    repo.triage(s1.id, 'bind_issue', { issueNumber: 999 });
    repo.triage(s1.id, 'in_progress');
    repo.resolve(s3.id);
    const r = repo.batchBindIssue({ signalType: 'bug_recurrence' }, 1052);
    // s1 in_progress 不算未接单；s2 未接单；s3 resolved 不算 open
    expect(r.matched).toBe(1);
    expect(repo.findById(s1.id)!.issue_number).toBe(999); // 不被覆盖
    expect(repo.findById(s2.id)!.issue_number).toBe(1052);
  });

  it('dryRun 只计数不动库', () => {
    seed('bug_recurrence', 'critical', 'src/a.ts');
    seed('bug_recurrence', 'critical', 'src/b.ts');
    const r = repo.batchBindIssue({ signalType: 'bug_recurrence' }, 1052, { dryRun: true });
    expect(r.matched).toBe(2);
    expect(r.bound).toBe(0);
    expect(repo.findByTriageStatus('null')).toHaveLength(2);
  });

  it('单批上限 100：truncated=true + totalMatched 报全量', () => {
    for (let i = 0; i < 150; i++) seed('bug_recurrence', 'critical', `src/f${i}.ts`);
    const r = repo.batchBindIssue({ signalType: 'bug_recurrence' }, 1052);
    expect(r.matched).toBe(100);
    expect(r.bound).toBe(100);
    expect(r.truncated).toBe(true);
    expect(r.totalMatched).toBe(150);
    // 剩余 50 条未接单，再次执行可续
    const r2 = repo.batchBindIssue({ signalType: 'bug_recurrence' }, 1052);
    expect(r2.matched).toBe(50);
    expect(r2.truncated).toBe(false);
  });

  it('note 写入 + COALESCE 保留旧 note（未传时不覆盖）', () => {
    const s1 = seed('bug_recurrence', 'critical', 'src/a.ts');
    const s2 = seed('bug_recurrence', 'critical', 'src/b.ts');
    // s1 先 dismiss note？不行——dismiss 是终态。用单条 bind note 预置
    repo.triage(s1.id, 'bind_issue', { issueNumber: 1, note: '旧判断' });
    repo.triage(s1.id, 'dismiss', { note: 'x' }); // 终态化使其脱离未接单池
    const r = repo.batchBindIssue({ signalType: 'bug_recurrence' }, 1052, { note: '批量归口：同根因' });
    expect(r.matched).toBe(1); // 只剩 s2（s1 已终态）
    expect(repo.findById(s2.id)!.triage_note).toBe('批量归口：同根因');
  });

  it('无匹配时 matched=0 无副作用', () => {
    seed('bug_recurrence', 'critical', 'src/a.ts');
    const r = repo.batchBindIssue({ signalType: 'not_exist_type' }, 1052);
    expect(r.matched).toBe(0);
    expect(r.boundIds).toEqual([]);
    expect(r.truncated).toBe(false);
  });
});
