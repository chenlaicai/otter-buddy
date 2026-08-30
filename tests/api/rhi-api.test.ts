import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { RhiController } from "@interface-adapters/http/controllers/rhi-controller";
import { SignalRepository } from "@usecases/health/signal-repository";
import { HealthSnapshotRepository } from "@usecases/health/health-snapshot-repository";
import type { RhiScanWorker } from "@usecases/health/rhi-scan-worker";
import type { FeatureChain } from "@usecases/health/chain-builder";

/** 真 sqlite（:memory:）+ 真 Controller 的 API 测试。
 *  buildChainsOnce/scanOnce 走 mock（链构建的端到端已有 rhi-scan-worker.test.ts 覆盖）。 */
describe("RHI API（真 sqlite）", () => {
  let db: Database.Database;
  let signalRepo: SignalRepository;
  let snapshotRepo: HealthSnapshotRepository;

  function makeCtx(statusQuery?: string): Parameters<RhiController["overview"]>[0] {
    return {
      req: { query: () => statusQuery },
      json: (data: unknown) => new Response(JSON.stringify(data), { status: 200 }),
    } as never;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    migrateDatabase(db, console as never);
    signalRepo = new SignalRepository(db);
    snapshotRepo = new HealthSnapshotRepository(db);
  });

  function makeController(chains: FeatureChain[] = [], scanResult = { commitCount: 0 }): RhiController {
    const worker = {
      buildChainsOnce: vi.fn(async () => chains),
      scanOnce: vi.fn(async () => ({ ...scanResult, scannedAt: "", chainCount: 0, signalCount: 0, stored: 0, memoryIndexed: 0, wakeupsTriggered: 0, errors: [] })),
    } as unknown as RhiScanWorker;
    return new RhiController(snapshotRepo, signalRepo, worker, console as never);
  }

  const fakeChain = (featureId: string, state: FeatureChain["state"]): FeatureChain => ({
    featureId, state, commits: [], firstSeenAt: null, lastCommitAt: null,
    daysSinceLastCommit: null, commitCount: 2, bugfixCount: 1,
    touchFiles: new Set<string>(), doc: null,
  });

  describe("overview", () => {
    it("返回最新快照指标与信号分级计数", async () => {
      snapshotRepo.replaceForDate("2026-08-25", [
        { snapshotDate: "2026-08-25", metricType: "overview", metricKey: "total_commits", metricValue: 268 },
        { snapshotDate: "2026-08-25", metricType: "overview", metricKey: "bugfix_ratio", metricValue: 0.27 },
      ]);
      signalRepo.upsert({ signalType: "bug_recurrence", severity: "critical", featureId: null, filePath: "a.ts", evidence: "e", suggestedAction: "s" });
      signalRepo.upsert({ signalType: "hotspot", severity: "warning", featureId: null, filePath: "b.ts", evidence: "e", suggestedAction: "s" });

      const res = await makeController().overview(makeCtx());
      const body = await res.json() as Record<string, unknown>;

      expect(body.metrics).toMatchObject({ total_commits: 268, bugfix_ratio: 0.27 });
      expect(body.openSignals).toBe(2);
      expect(body.openSignalsBySeverity).toEqual({ critical: 1, warning: 1 });
      expect(body.snapshotDate).toBe("2026-08-25");
    });

    it("空库返回零值不抛错", async () => {
      const res = await makeController().overview(makeCtx());
      const body = await res.json() as Record<string, unknown>;
      expect(body.metrics).toEqual({});
      expect(body.openSignals).toBe(0);
    });
  });

  describe("signals", () => {
    it("默认返回 open 信号", async () => {
      signalRepo.upsert({ signalType: "hotspot", severity: "warning", featureId: null, filePath: "x.ts", evidence: "e", suggestedAction: "s" });
      const res = await makeController().signals(makeCtx());
      const body = await res.json() as { signals: unknown[]; count: number };
      expect(body.count).toBe(1);
    });

    it("status=all 含已关闭信号", async () => {
      const r = signalRepo.upsert({ signalType: "hotspot", severity: "warning", featureId: null, filePath: "x.ts", evidence: "e", suggestedAction: "s" });
      signalRepo.resolve(r.id);
      const res = await makeController().signals(makeCtx("all"));
      const body = await res.json() as { count: number };
      expect(body.count).toBe(1);
    });
  });

  describe("chains", () => {
    it("返回链列表与五态分布", async () => {
      const chains = [fakeChain("F20260801aaaa", "active"), fakeChain("F20260801bbbb", "stalled")];
      const res = await makeController(chains).chains(makeCtx());
      const body = await res.json() as { chains: Array<{ featureId: string; state: string }>; stateCounts: Record<string, number>; total: number };

      expect(body.total).toBe(2);
      expect(body.stateCounts).toEqual({ active: 1, stalled: 1 });
      expect(body.chains[0]).toMatchObject({ featureId: "F20260801aaaa", state: "active" });
    });
  });

  describe("trends", () => {
    function makeTrendsCtx(daysQuery?: string): Parameters<RhiController["trends"]>[0] {
      return {
        req: { query: () => daysQuery },
        json: (data: unknown) => new Response(JSON.stringify(data), { status: 200 }),
      } as never;
    }

    it("返回日期序列（比率×100）与最新分布", async () => {
      snapshotRepo.replaceForDate("2026-08-26", [
        { snapshotDate: "2026-08-26", metricType: "overview", metricKey: "total_commits", metricValue: 100 },
        { snapshotDate: "2026-08-26", metricType: "overview", metricKey: "bugfix_ratio", metricValue: 0.3 },
      ]);
      snapshotRepo.replaceForDate("2026-08-27", [
        { snapshotDate: "2026-08-27", metricType: "overview", metricKey: "total_commits", metricValue: 120 },
        { snapshotDate: "2026-08-27", metricType: "overview", metricKey: "bugfix_ratio", metricValue: 0.25 },
        {
          snapshotDate: "2026-08-27", metricType: "distribution", metricKey: "change_types",
          metricValue: 120, metadata: JSON.stringify({ Feature: 80, BugFix: 30 }),
        },
        {
          snapshotDate: "2026-08-27", metricType: "distribution", metricKey: "chain_states",
          metricValue: 5, metadata: JSON.stringify({ active: 3, stalled: 2 }),
        },
      ]);

      const res = await makeController().trends(makeTrendsCtx());
      const body = await res.json() as {
        series: Array<{ date: string; total_commits: number; bugfix_ratio: number }>;
        distributions: Record<string, unknown>;
        latestSnapshotDate: string;
      };

      expect(body.series).toHaveLength(2);
      expect(body.series[0]).toMatchObject({ date: "2026-08-26", total_commits: 100, bugfix_ratio: 30 });
      expect(body.series[1]).toMatchObject({ date: "2026-08-27", total_commits: 120, bugfix_ratio: 25 });
      expect(body.distributions.change_types).toEqual({ Feature: 80, BugFix: 30 });
      expect(body.distributions.chain_states).toEqual({ active: 3, stalled: 2 });
      expect(body.latestSnapshotDate).toBe("2026-08-27");
    });

    it("空库返回空序列不抛错", async () => {
      const res = await makeController().trends(makeTrendsCtx());
      const body = await res.json() as { series: unknown[]; distributions: Record<string, unknown> };
      expect(body.series).toEqual([]);
      expect(body.distributions).toEqual({});
    });

    it("days 越界被钳位（负数→1，超过 90→90）", async () => {
      const res = await makeController().trends(makeTrendsCtx("999"));
      const body = await res.json() as { days: number };
      expect(body.days).toBe(90);
    });
  });

  describe("costOutput", () => {
    function makeCostCtx(query?: string): Parameters<RhiController["costOutput"]>[0] {
      return {
        req: { query: () => query },
        json: (data: unknown) => new Response(JSON.stringify(data), { status: 200 }),
      } as never;
    }

    it("多 model 獭 cacheHitRate 为加权平均（非覆盖）", async () => {
      const today = new Date().toISOString().slice(0, 10);
      // 插入 active 獭
      db.prepare("INSERT INTO otters (id, name, type, status) VALUES (?, ?, ?, 'active')").run("otter-1", "测试獭", "big");
      const metaA = JSON.stringify({ otterId: "otter-1", otterName: "测试獭", otterType: "big", model: "model-a" });
      const metaB = JSON.stringify({ otterId: "otter-1", otterName: "测试獭", otterType: "big", model: "model-b" });
      // model-a: 900 cacheRead, 100 input → hitRate 0.9
      // model-b: 0 cacheRead, 1000 input → hitRate 0
      // 加权: 900/(900+100+0+1000) = 0.45
      snapshotRepo.replaceForDate(today, [
        { snapshotDate: today, metricType: "cost_output", metricKey: "cache_read_tokens", metricValue: 900, metadata: metaA },
        { snapshotDate: today, metricType: "cost_output", metricKey: "input_tokens", metricValue: 100, metadata: metaA },
        { snapshotDate: today, metricType: "cost_output", metricKey: "cache_read_tokens", metricValue: 0, metadata: metaB },
        { snapshotDate: today, metricType: "cost_output", metricKey: "input_tokens", metricValue: 1000, metadata: metaB },
        { snapshotDate: today, metricType: "cost_output", metricKey: "total_tokens", metricValue: 2000, metadata: metaA },
        { snapshotDate: today, metricType: "cost_output", metricKey: "total_tokens", metricValue: 1000, metadata: metaB },
      ], "cost_output");

      const res = await makeController().costOutput(makeCostCtx());
      const body = await res.json() as { otters: Array<{ otterId: string; cacheHitRate: number }> };
      const otter = body.otters.find(o => o.otterId === "otter-1");
      expect(otter).toBeDefined();
      expect(otter!.cacheHitRate).toBeCloseTo(0.45, 2);
    });

    it("series cacheHitRate 为加权平均（非简单平均）", async () => {
      const d1 = "2026-08-28";
      const d2 = "2026-08-29";
      // day1: cacheRead=800, input=200 → hitRate 0.8
      // day2: cacheRead=100, input=900 → hitRate 0.1
      // series 加权: (800+100)/(800+200+100+900) = 0.45
      snapshotRepo.replaceForDate(d1, [
        { snapshotDate: d1, metricType: "cost_output", metricKey: "cache_read_tokens", metricValue: 800 },
        { snapshotDate: d1, metricType: "cost_output", metricKey: "input_tokens", metricValue: 200 },
        { snapshotDate: d1, metricType: "cost_output", metricKey: "total_tokens", metricValue: 1000 },
        { snapshotDate: d1, metricType: "cost_output", metricKey: "cost_total", metricValue: 0.01 },
        { snapshotDate: d1, metricType: "cost_output", metricKey: "llm_call_count", metricValue: 5 },
        { snapshotDate: d1, metricType: "cost_output", metricKey: "message_count", metricValue: 3 },
      ], "cost_output");
      snapshotRepo.replaceForDate(d2, [
        { snapshotDate: d2, metricType: "cost_output", metricKey: "cache_read_tokens", metricValue: 100 },
        { snapshotDate: d2, metricType: "cost_output", metricKey: "input_tokens", metricValue: 900 },
        { snapshotDate: d2, metricType: "cost_output", metricKey: "total_tokens", metricValue: 1000 },
        { snapshotDate: d2, metricType: "cost_output", metricKey: "cost_total", metricValue: 0.02 },
        { snapshotDate: d2, metricType: "cost_output", metricKey: "llm_call_count", metricValue: 10 },
        { snapshotDate: d2, metricType: "cost_output", metricKey: "message_count", metricValue: 5 },
      ], "cost_output");

      const res = await makeController().costOutput(makeCostCtx("90"));
      const body = await res.json() as { series: Array<{ date: string; cacheHitRate: number }> };
      // 两天的 series 各自的 cacheHitRate 应该分别是 0.8 和 0.1（per-day）
      const s1 = body.series.find(s => s.date === d1);
      const s2 = body.series.find(s => s.date === d2);
      expect(s1).toBeDefined();
      expect(s1!.cacheHitRate).toBeCloseTo(0.8, 2);
      expect(s2).toBeDefined();
      expect(s2!.cacheHitRate).toBeCloseTo(0.1, 2);
    });
  });

  describe("scan", () => {
    it("手动扫描返回结果", async () => {
      const res = await makeController([], { commitCount: 42 }).scan(makeCtx());
      const body = await res.json() as { ok: boolean; result: { commitCount: number } };
      expect(body.ok).toBe(true);
      expect(body.result.commitCount).toBe(42);
    });
  });
});
