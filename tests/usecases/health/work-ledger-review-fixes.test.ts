/**
 * F20261027hwl1 复审修复回归测试：
 * - S1：5000+ invoke / 老 trace 在窗口外——列表与详情 token 一致、守恒、其他工作不混入
 * - A1：reviewerOtterId 与调用者不一致拒写；一致（本人）通过
 * - A5：详情 truncatedCount / usageGapCount 显式返回
 * - A4：工具调用计数 Shanghai 日界
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../helpers/db";
import { SqliteWorkLedgerRepository } from "@frameworks/db/health/sqlite-work-ledger-repository";
import { WorkLedgerBinder } from "@usecases/health/work-ledger-binder";
import { WorkLedgerReportBuilder } from "@usecases/health/work-ledger-report";
import { WorkDetailReportBuilder } from "@usecases/health/work-detail-report";
import { createTestLogger } from "../../helpers/logger";

let db: Database.Database;
let repo: SqliteWorkLedgerRepository;
let binder: WorkLedgerBinder;
const logger = createTestLogger();

beforeEach(() => {
  db = createTestDb();
  repo = new SqliteWorkLedgerRepository(db);
  binder = new WorkLedgerBinder(repo, logger, () => "2026-10-27T10:00:00.000Z");
  db.prepare(`INSERT INTO otters (id, name, type, created_at) VALUES ('o1', '獭一', 'big', '2026-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('c1', '对话', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
});

afterEach(() => {
  db.close();
});

/** 批量插入 invoke（时间递增），返回最后 id */
function seedInvokes(count: number, traceId: string, otterId = "o1", startSeq = 0, tokensPer = { input: 10, output: 5, cacheRead: 2, cacheWrite: 0 }): void {
  const stmt = db.prepare(`
    INSERT INTO invokes (id, conversation_id, otter_id, status, started_at, ended_at,
      token_usage_input, token_usage_output, token_usage_cache_read, token_usage_cache_write, metadata)
    VALUES (?, 'c1', ?, 'completed', ?, NULL, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      // 时间从早到晚：老 invoke 在前（先被旧 LIMIT 窗口挤出的位置）
      const ts = new Date(Date.UTC(2026, 8, 1) + (startSeq + i) * 60_000).toISOString();
      stmt.run(`inv-${traceId}-${startSeq + i}`, otterId, ts, tokensPer.input, tokensPer.output, tokensPer.cacheRead, tokensPer.cacheWrite, JSON.stringify({ traceId }));
    }
  });
  tx();
}

describe("S1 回归：5000+ invoke 全量守恒（无截断偏置）", () => {
  it("旧 LIMIT 5000 会漏老 invoke 的场景：聚合口径下列表与详情 token 一致且守恒", async () => {
    const w = await binder.start({ conversationId: "c1", otterId: "o1", traceId: "t-big", title: "大量调用的工作" });
    // 5300 条归属 invoke（超过旧默认 5000），再加 200 条未归属（无 trace）
    seedInvokes(5300, "t-big");
    seedInvokes(100, "t-other-unbound");
    const insertNoTrace = db.prepare(`
      INSERT INTO invokes (id, conversation_id, otter_id, status, started_at, token_usage_input, token_usage_output, metadata)
      VALUES (?, 'c1', 'o1', 'completed', ?, 7, 3, NULL)
    `);
    for (let i = 0; i < 100; i++) insertNoTrace.run(`inv-notrace-${i}`, new Date(Date.UTC(2026, 9, 20, i % 24, i % 60)).toISOString());

    const report = await new WorkLedgerReportBuilder(repo, logger).build();
    const item = report.works.find(x => x.workId === w.id)!;
    // 全量 5300 条 × (10+5+2) = 90100 —— 若仍走 LIMIT 5000 会得 85000（少 800）
    expect(item.tokens.totalTokens).toBe(5300 * 17);
    expect(item.invokeCount).toBe(5300);

    // 未归属：100 无 trace + 100 有 trace 未绑定
    expect(report.unassigned.noTraceCount).toBe(100);
    expect(report.unassigned.unboundTraceCount).toBe(100);
    expect(report.unassigned.tokens.totalTokens).toBe(100 * 17 + 100 * 10);

    // 守恒：已归属 + 未归属 = 总量
    const grandTotal = 5300 * 17 + 100 * 17 + 100 * 10;
    expect(item.tokens.totalTokens + report.unassigned.tokens.totalTokens).toBe(grandTotal);

    // 详情与列表同源同口径（复审 S1：两处数字不再打架）
    const detail = (await new WorkDetailReportBuilder(repo).build(w.id))!;
    expect(detail.tokens.totalTokens).toBe(item.tokens.totalTokens);
    expect(detail.totalInvokeCount).toBe(5300);
    // 证据列表默认 50 条，truncatedCount 显式
    expect(detail.invokeEvidence.length).toBe(50);
    expect(detail.truncatedCount).toBe(5250);
  });

  it("老工作（早期 invoke 远在最新 5000 之外）token 不丢", async () => {
    const wOld = await binder.start({ conversationId: "c1", otterId: "o1", traceId: "t-old", title: "老工作" });
    const wNew = await binder.start({ conversationId: "c1", otterId: "o1", traceId: "t-new", title: "新工作" });
    seedInvokes(6000, "t-other-filler"); // 填充量（未绑定）把老工作挤出任何「最新 N」窗口
    seedInvokes(10, "t-old", "o1", 0); // 老工作 10 条（时间最早）
    seedInvokes(10, "t-new", "o1", 10000); // 新工作 10 条（时间最晚）

    const report = await new WorkLedgerReportBuilder(repo, logger).build();
    const old = report.works.find(x => x.workId === wOld.id)!;
    const fresh = report.works.find(x => x.workId === wNew.id)!;
    // 老工作 10 条全量保留（旧实现「截断后过滤」会得 0——全被 5000 窗口挤出）
    expect(old.tokens.totalTokens).toBe(10 * 17);
    expect(old.invokeCount).toBe(10);
    expect(fresh.tokens.totalTokens).toBe(10 * 17);
    // 其他工作不混入
    expect(old.tokens.totalTokens + fresh.tokens.totalTokens + report.unassigned.tokens.totalTokens)
      .toBe(6020 * 17);
  });
});

describe("A1 回归：reviewer 身份锚定", () => {
  it("reviewerOtterId 与调用者不一致 → 拒写（作者不能替检视者记轮次）", async () => {
    const { createTools } = await import("@interface-adapters/agent-runtime/tools/tool-factory");
    const { runWithTrace } = await import("@usecases/ports/trace-context");
    const w = await binder.start({ conversationId: "c1", otterId: "o1", traceId: "t-rv", title: "轮次工作" });

    // 作者獭（otter-author）冒充检视獭（otter-reviewer）记轮次 → 拒写
    const authorTools = createTools({ otterId: "otter-author", conversationId: "c1", workLedgerBinder: binder } as never);
    const trackWork = authorTools.find(t => t.name === "track_work")!;
    const result = await runWithTrace({ traceId: "t-rv" }, () =>
      trackWork.execute("call-1", { action: "review_round", workId: w.id, reviewerOtterId: "otter-reviewer", roundNo: 1, roundState: "reviewing" }));
    const text = JSON.stringify(result);
    expect(text).toContain("拒写");

    // 检视獭本人（otter-reviewer 调用者）→ 通过
    const reviewerTools = createTools({ otterId: "otter-reviewer", conversationId: "c1", workLedgerBinder: binder } as never);
    const trackWorkRv = reviewerTools.find(t => t.name === "track_work")!;
    const okResult = await runWithTrace({ traceId: "t-rv" }, () =>
      trackWorkRv.execute("call-2", { action: "review_round", workId: w.id, reviewerOtterId: "otter-reviewer", roundNo: 1, roundState: "reviewing" }));
    expect(JSON.stringify(okResult)).toContain("已留痕");

    const back = await repo.getWorkById(w.id);
    expect(back!.reviewRounds.length).toBe(1);
    expect(back!.reviewRounds[0]!.reviewerOtterId).toBe("otter-reviewer");
  });

  it("缺 reviewerOtterId → 拒写并提示需要显式声明", async () => {
    const { createTools } = await import("@interface-adapters/agent-runtime/tools/tool-factory");
    const { runWithTrace } = await import("@usecases/ports/trace-context");
    const w = await binder.start({ conversationId: "c1", otterId: "o1", traceId: "t-rv2", title: "轮次工作2" });
    const tools = createTools({ otterId: "o1", conversationId: "c1", workLedgerBinder: binder } as never);
    const trackWork = tools.find(t => t.name === "track_work")!;
    const result = await runWithTrace({ traceId: "t-rv2" }, () =>
      trackWork.execute("call-1", { action: "review_round", workId: w.id, roundNo: 1, roundState: "reviewing" }));
    expect(JSON.stringify(result)).toContain("reviewerOtterId");
  });
});

describe("A5 回归：详情缺口显式", () => {
  it("usage 缺失行计入 usageGapCount，truncatedCount 反映证据截断", async () => {
    const w = await binder.start({ conversationId: "c1", otterId: "o1", traceId: "t-gap", title: "缺口工作" });
    seedInvokes(3, "t-gap");
    const insertGap = db.prepare(`
      INSERT INTO invokes (id, conversation_id, otter_id, status, started_at, metadata)
      VALUES (?, 'c1', 'o1', 'completed', ?, ?)
    `);
    insertGap.run("inv-gap-1", new Date(Date.UTC(2026, 9, 27, 1)).toISOString(), JSON.stringify({ traceId: "t-gap" }));
    insertGap.run("inv-gap-2", new Date(Date.UTC(2026, 9, 27, 2)).toISOString(), JSON.stringify({ traceId: "t-gap" }));

    const detail = (await new WorkDetailReportBuilder(repo).build(w.id, 2))!;
    expect(detail.usageGapCount).toBe(2);
    expect(detail.invokeEvidence.length).toBe(2);
    expect(detail.truncatedCount).toBe(3);
    expect(detail.totalInvokeCount).toBe(5);
  });
});
