/** #1761：同族信号批量忽略，复用单条终态语义且不越过 issue 边界。 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../helpers/db";
import { SignalRepository } from "@usecases/health/signal-repository";

describe("SignalRepository.batchDismiss（#1761）", () => {
  let db: Database.Database;
  let repo: SignalRepository;
  let seq = 0;

  beforeEach(() => {
    db = createTestDb();
    repo = new SignalRepository(db);
  });
  afterEach(() => { db.close(); });

  const seed = (signalType = "guard_intercept") => {
    return repo.upsert({
      signalType,
      severity: "high",
      featureId: null,
      filePath: `src/signal-${seq++}.ts`,
      evidence: "x",
      suggestedAction: null,
    }).id;
  };

  it("按 issue 收尾已归口/修复中的 open 信号，不误伤他族、未归口或已终态信号", () => {
    const bound = seed();
    const working = seed();
    const otherIssue = seed();
    const unassigned = seed();
    repo.triage(bound, "bind_issue", { issueNumber: 1761, note: "旧归口说明", now: new Date("2026-11-05T00:00:00Z") });
    repo.triage(working, "bind_issue", { issueNumber: 1761, now: new Date("2026-11-05T00:00:00Z") });
    repo.triage(working, "in_progress", { now: new Date("2026-11-05T00:00:00Z") });
    repo.triage(otherIssue, "bind_issue", { issueNumber: 9999, now: new Date("2026-11-05T00:00:00Z") });
    repo.resolve(unassigned);

    const result = repo.batchDismiss(
      { filterIssueNumber: 1761 },
      "issue #1761 已修复，同族收尾",
      { now: new Date("2026-11-05T01:00:00Z") },
    );
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ matched: 2, dismissed: 2, totalMatched: 2, truncated: false });
    for (const id of [bound, working]) {
      const row = db.prepare("SELECT * FROM signals WHERE id = ?").get(id) as Record<string, unknown>;
      expect(row.status).toBe("dismissed");
      expect(row.resolved_at).toBe("2026-11-05T01:00:00.000Z");
      expect(row.triage_status).toBeNull();
      expect(row.issue_number).toBeNull();
      // 与单条 dismiss 一致：不清空/刷新原归口时间，历史去向写入 note。
      expect(row.triaged_at).toBe("2026-11-05T00:00:00.000Z");
      expect(row.triage_note).toBe("issue #1761 已修复，同族收尾");
    }
    expect((repo.findById(otherIssue)!).status).toBe("open");
    expect((repo.findById(otherIssue)!).issue_number).toBe(9999);
    expect((repo.findById(unassigned)!).status).toBe("resolved");
  });

  it("dryRun 只预览数量，不写任何处置字段；空 note 拒绝", () => {
    const id = seed();
    repo.triage(id, "bind_issue", { issueNumber: 1761 });
    const preview = repo.batchDismiss({ filterIssueNumber: 1761 }, "issue #1761 收尾预览", { dryRun: true });
    expect(preview).toMatchObject({ ok: true, matched: 1, dismissed: 0 });
    expect((repo.findById(id)!).status).toBe("open");
    expect((repo.findById(id)!).issue_number).toBe(1761);
    expect(repo.batchDismiss({ filterIssueNumber: 1761 }, "   ").ok).toBe(false);
    expect(repo.batchDismiss({ filterSeverity: "high" }, "issue #1761 不得只按严重度全库忽略").ok).toBe(false);
  });

  it("单批 100 条并报告续批，下一批只处理剩余 open 信号", { timeout: 20_000 }, () => {
    for (let i = 0; i < 101; i++) repo.triage(seed(), "bind_issue", { issueNumber: 1761 });
    const first = repo.batchDismiss({ filterIssueNumber: 1761 }, "issue #1761 第一批收尾");
    expect(first).toMatchObject({ ok: true, dismissed: 100, totalMatched: 101, truncated: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM signals WHERE status = 'open'").get()).toEqual({ n: 1 });
    const second = repo.batchDismiss({ filterIssueNumber: 1761 }, "issue #1761 剩余收尾");
    expect(second).toMatchObject({ ok: true, matched: 1, dismissed: 1, totalMatched: 1, truncated: false });
    expect(first.matched).toBe(100);
  });

  it("同族不同判断说明可分批留痕，预览返回本批数量而非总量", () => {
    for (let i = 0; i < 101; i++) seed();
    const preview = repo.batchDismiss({ filterSignalType: "guard_intercept" }, "第一批独立判断", { dryRun: true });
    expect(preview).toMatchObject({ ok: true, matched: 100, dismissed: 0, totalMatched: 101, truncated: true });
    const first = repo.batchDismiss({ filterSignalType: "guard_intercept" }, "第一批独立判断");
    expect(first).toMatchObject({ ok: true, matched: 100, dismissed: 100, truncated: true });
    const second = repo.batchDismiss({ filterSignalType: "guard_intercept" }, "第二批独立判断");
    expect(second).toMatchObject({ ok: true, matched: 1, dismissed: 1, truncated: false });
    const notes = db.prepare("SELECT triage_note, COUNT(*) AS n FROM signals GROUP BY triage_note ORDER BY n DESC").all();
    expect(notes).toEqual([
      { triage_note: "第一批独立判断", n: 100 },
      { triage_note: "第二批独立判断", n: 1 },
    ]);
  });
});
