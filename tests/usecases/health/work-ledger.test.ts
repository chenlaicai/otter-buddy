/**
 * F20261027hwl1 工作账本 A 类行为测试（createTestDb 全生产 schema）。
 *
 * 覆盖（任务简报执行要求 5）：
 * - 同 conversation 多工作不混（trace 绑定是唯一归属键）
 * - 跨獭链（多 otter invoke 归同一 trace → 同一工作）
 * - 未归属细分（有 trace 未绑定 / 无 trace）
 * - 轮次 upsert（同轮推进覆盖，不同轮追加）
 * - 404 详情（不返回演示对象）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../helpers/db";
import { SqliteWorkLedgerRepository } from "@frameworks/db/health/sqlite-work-ledger-repository";
import { WorkLedgerBinder } from "@usecases/health/work-ledger-binder";
import { WorkLedgerReportBuilder } from "@usecases/health/work-ledger-report";
import { WorkDetailReportBuilder } from "@usecases/health/work-detail-report";
import { createTestLogger } from "../../helpers/logger";
import type { Invoke } from "@entities/conversation/invoke";
import { SqliteInvokeRepository } from "@frameworks/db/conversation/sqlite-invoke-repository";

let db: Database.Database;
let repo: SqliteWorkLedgerRepository;
let binder: WorkLedgerBinder;
let invokeRepo: SqliteInvokeRepository;
const logger = createTestLogger();

beforeEach(() => {
  db = createTestDb();
  repo = new SqliteWorkLedgerRepository(db);
  binder = new WorkLedgerBinder(repo, logger, () => "2026-10-27T10:00:00.000Z");
  invokeRepo = new SqliteInvokeRepository(db);
  db.prepare(`INSERT INTO otters (id, name, type, created_at) VALUES ('otter-big', '大獭', 'big', '2026-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO otters (id, name, type, created_at) VALUES ('otter-small', '执行獭', 'assistant', '2026-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO otters (id, name, type, created_at) VALUES ('otter-reviewer', '检视獭', 'assistant', '2026-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', '测试对话', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
});

afterEach(() => {
  db.close();
});

function makeInvoke(id: string, otterId: string, traceId: string | null, usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }): void {
  const inv: Invoke = {
    id,
    conversationId: "conv-1",
    otterId,
    status: "completed",
    triggerEntryId: null,
    talkingStonePassedTo: null,
    startedAt: "2026-10-27T09:00:00Z",
    endedAt: "2026-10-27T09:05:00Z",
    toolCallCount: 0,
    tokenUsageInput: usage?.input ?? null,
    tokenUsageOutput: usage?.output ?? null,
    tokenUsageCacheRead: usage?.cacheRead ?? null,
    tokenUsageCacheWrite: usage?.cacheWrite ?? null,
    ctxWindowUsed: null,
    pid: null,
    metadata: traceId ? { traceId } : null,
  };
  void invokeRepo.createInvoke(inv);
}

describe("同 conversation 多工作不混", () => {
  it("两个工作分别绑定不同 trace，token 不串账", async () => {
    const w1 = await binder.start({ conversationId: "conv-1", otterId: "otter-big", traceId: "trace-A", title: "工作一" });
    const w2 = await binder.start({ conversationId: "conv-1", otterId: "otter-big", traceId: "trace-B", title: "工作二" });
    expect(w1.id).not.toBe(w2.id);

    makeInvoke("inv-a1", "otter-big", "trace-A", { input: 100, output: 50, cacheRead: 10, cacheWrite: 0 });
    makeInvoke("inv-a2", "otter-small", "trace-A", { input: 200, output: 80, cacheRead: 20, cacheWrite: 0 });
    makeInvoke("inv-b1", "otter-big", "trace-B", { input: 1000, output: 500, cacheRead: 100, cacheWrite: 0 });

    const report = await new WorkLedgerReportBuilder(repo, logger).build();
    const item1 = report.works.find(w => w.workId === w1.id)!;
    const item2 = report.works.find(w => w.workId === w2.id)!;
    expect(item1.tokens.totalTokens).toBe(100 + 50 + 10 + 200 + 80 + 20);
    expect(item2.tokens.totalTokens).toBe(1000 + 500 + 100);
    // 工作一有两个参与獭（跨獭链经同一 trace 归并）
    expect(item1.participants.length).toBe(2);
  });
});

describe("跨獭链与轮次", () => {
  it("检视轮次同轮推进覆盖、不同轮追加；报告区分「未记录」", async () => {
    const w = await binder.start({ conversationId: "conv-1", otterId: "otter-big", traceId: "trace-R", title: "带检视的工作" });
    makeInvoke("inv-r1", "otter-big", "trace-R");

    // 第 1 轮：reviewing → awaiting-fix（同轮状态推进覆盖）
    await binder.recordReviewRound(w.id, { roundNo: 1, reviewerOtterId: "otter-reviewer", state: "reviewing", startedInvokeId: "inv-r1", startedAt: "2026-10-27T10:00:00Z" });
    await binder.recordReviewRound(w.id, { roundNo: 1, reviewerOtterId: "otter-reviewer", state: "awaiting-fix" });
    // 第 2 轮 delta-review → passed
    await binder.recordReviewRound(w.id, { roundNo: 2, reviewerOtterId: "otter-reviewer", state: "delta-review", deltaInvokeId: "inv-r1" });
    await binder.recordReviewRound(w.id, { roundNo: 2, reviewerOtterId: "otter-reviewer", state: "passed", passedAt: "2026-10-27T12:00:00Z" });

    const back = await repo.getWorkById(w.id);
    expect(back!.reviewRounds.length).toBe(2);
    expect(back!.reviewRounds[0]!.state).toBe("awaiting-fix");
    expect(back!.reviewRounds[0]!.startedInvokeId).toBe("inv-r1"); // 首次留痕不被覆盖丢
    expect(back!.reviewRounds[1]!.state).toBe("passed");

    const report = await new WorkLedgerReportBuilder(repo, logger).build();
    const item = report.works.find(x => x.workId === w.id)!;
    expect(item.roundsRecorded).toBe(true);
    expect(item.reviewRounds.length).toBe(2);
  });
});

describe("未归属细分与覆盖率", () => {
  it("有 trace 未绑定 / 无 trace 分开计数；usage 缺失显式统计", async () => {
    await binder.start({ conversationId: "conv-1", otterId: "otter-big", traceId: "trace-X", title: "已归属工作" });
    makeInvoke("inv-x", "otter-big", "trace-X", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
    makeInvoke("inv-unbound", "otter-big", "trace-orphan", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 });
    makeInvoke("inv-notrace", "otter-big", null);
    makeInvoke("inv-gap", "otter-big", null);

    const report = await new WorkLedgerReportBuilder(repo, logger).build();
    expect(report.unassigned.unboundTraceCount).toBe(1);
    expect(report.unassigned.noTraceCount).toBe(2);
    expect(report.unassigned.tokens.totalTokens).toBe(150);
    // usage 缺失 2 条（inv-notrace/inv-gap 的四分量全 null）——数据缺口显式，不当零
    expect(report.usageGapInvokeCount).toBe(2);
    // 覆盖率 = 1 已归属 / 4 总调用
    expect(report.attributionCoverage).toBeCloseTo(0.25);
  });
});

describe("resume 跨对话与状态投影", () => {
  it("resume 绑定新 trace 到同一工作（跨对话续接不另起）", async () => {
    db.prepare(`INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-2', '续接对话', 'active', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')`).run();
    const w = await binder.start({ conversationId: "conv-1", otterId: "otter-big", traceId: "trace-1", title: "跨对话工作" });
    const resumed = await binder.resume({ conversationId: "conv-2", otterId: "otter-big", workId: w.id, traceId: "trace-2" });
    expect(resumed!.id).toBe(w.id);

    // 两条 trace 的 invoke 都归到同一工作
    db.prepare(`INSERT INTO invokes (id, conversation_id, otter_id, status, started_at, token_usage_input, token_usage_output, metadata) VALUES ('inv-c1', 'conv-1', 'otter-big', 'completed', '2026-10-27T08:00:00Z', 10, 5, ?)`).run(JSON.stringify({ traceId: "trace-1" }));
    db.prepare(`INSERT INTO invokes (id, conversation_id, otter_id, status, started_at, token_usage_input, token_usage_output, metadata) VALUES ('inv-c2', 'conv-2', 'otter-big', 'completed', '2026-10-27T09:00:00Z', 20, 8, ?)`).run(JSON.stringify({ traceId: "trace-2" }));
    const report = await new WorkLedgerReportBuilder(repo, logger).build();
    expect(report.works.length).toBe(1);
    expect(report.works[0]!.invokeCount).toBe(2);
  });

  it("complete 只记投影状态，cancelled 工作 resume 拒绝", async () => {
    const w = await binder.start({ conversationId: "conv-1", otterId: "otter-big", traceId: "trace-s", title: "状态工作" });
    await binder.complete(w.id, "merged");
    expect((await repo.getWorkById(w.id))!.status).toBe("merged");
    await binder.cancel(w.id);
    const resumed = await binder.resume({ conversationId: "conv-1", otterId: "otter-big", workId: w.id, traceId: "trace-new" });
    expect(resumed).toBeNull();
  });
});

describe("详情报告 404", () => {
  it("不存在的 workId 返回 null（不返回演示对象）", async () => {
    const detail = await new WorkDetailReportBuilder(repo).build("nonexistent");
    expect(detail).toBeNull();
  });
});
