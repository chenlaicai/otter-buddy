import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { RhiController } from "@interface-adapters/http/controllers/rhi-controller";
import { SignalRepository } from "@usecases/health/signal-repository";
import { HealthSnapshotRepository } from "@usecases/health/health-snapshot-repository";
import type { RhiScanWorker } from "@usecases/health/rhi-scan-worker";
import type { FeatureChain } from "@usecases/health/chain-builder";
import { DomainError } from "@entities/errors";

/** 真 sqlite（:memory:）+ 真 Controller 的 API 测试。
 *  buildChainsOnce/scanOnce 走 mock（链构建的端到端已有 rhi-scan-worker.test.ts 覆盖）。
 *  无闭包依赖的 helper 放模块级——describe 内联会触发 max-lines-per-function（审视处置中曾超限） */

function makeCtx(statusQuery?: string): Parameters<RhiController["overview"]>[0] {
  return {
    req: { query: () => statusQuery },
    json: (data: unknown) => new Response(JSON.stringify(data), { status: 200 }),
  } as never;
}

function makeDetailCtx(featureId: string): Parameters<RhiController["chainDetail"]>[0] {
  return {
    req: { param: () => featureId },
    json: (data: unknown, status?: number) => new Response(JSON.stringify(data), { status: status ?? 200 }),
  } as never;
}

/** #581：断言错误路径状态码的 ctx（handleError 会调 c.get('requestId')，必须 mock） */
function makeStatusCtx(query?: string, params?: Record<string, string>): Parameters<RhiController["overview"]>[0] {
  return {
    req: { query: () => query, param: (name: string) => params?.[name] },
    get: () => undefined,
    json: (data: unknown, status?: number) => new Response(JSON.stringify(data), { status: status ?? 200 }),
  } as never;
}

const fakeChain = (featureId: string, state: FeatureChain["state"], opts?: { doc?: FeatureChain["doc"]; daysSinceLastCommit?: number | null }): FeatureChain => ({
  featureId, state, commits: [], firstSeenAt: null, lastCommitAt: null,
  daysSinceLastCommit: opts?.daysSinceLastCommit ?? null, commitCount: 2, bugfixCount: 1,
  touchFiles: new Set<string>(), doc: opts?.doc ?? null,
});

/** chainDetail 用例的链夹具（含全类型 commit 序列，Issue #644） */
function fakeDetailChain(): FeatureChain {
  return {
    featureId: "F20260801aaaa",
    state: "stalled",
    commits: [
      { sha: "abcdef1234567890", date: new Date("2026-08-10T00:00:00Z"), message: "引入", changeType: "New Feature", filesChanged: ["a.ts"], prNumber: null },
      { sha: "1234567890abcdef", date: new Date("2026-08-20T00:00:00Z"), message: "修复", changeType: "BugFix", filesChanged: ["a.ts"], prNumber: null },
    ],
    firstSeenAt: new Date("2026-08-10T00:00:00Z"),
    lastCommitAt: new Date("2026-08-20T00:00:00Z"),
    daysSinceLastCommit: 5,
    commitCount: 2,
    bugfixCount: 1,
    touchFiles: new Set(["a.ts"]),
    doc: { id: "F20260801aaaa", title: "测试链", status: "development", changeType: "feature", tags: [], modules: [], causalLinksFrom: [], supersedes: [], filePath: "", createdAt: null, createdInConversationId: null },
  };
}

describe("RHI API（真 sqlite）", () => {
  let db: Database.Database;
  let signalRepo: SignalRepository;
  let snapshotRepo: HealthSnapshotRepository;

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

    it("Issue #652 验收：low critical ×2 + normal critical ×1 → critical 计数 = 1，低置信单列", async () => {
      signalRepo.upsert({ signalType: "chain_stall", severity: "critical", featureId: "F1", filePath: null, evidence: "e", suggestedAction: "s", confidence: "low" });
      signalRepo.upsert({ signalType: "chain_stall", severity: "critical", featureId: "F2", filePath: null, evidence: "e", suggestedAction: "s", confidence: "low" });
      signalRepo.upsert({ signalType: "bug_recurrence", severity: "critical", featureId: null, filePath: "a.ts", evidence: "e", suggestedAction: "s" });

      const res = await makeController().overview(makeCtx());
      const body = await res.json() as { openSignals: number; openSignalsBySeverity: { critical: number; warning: number }; openSignalsByConfidence: { normal: number; low: number } };
      expect(body.openSignals).toBe(3); // 总数不变（数据不丢）
      expect(body.openSignalsBySeverity.critical).toBe(1); // low 不推高主警报数
      expect(body.openSignalsByConfidence).toEqual({ normal: 1, low: 2 });
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
    it("返回链列表与五态分布 + 高扇入排除清单（Issue #647 验收：可见）", async () => {
      const chains = [fakeChain("F20260801aaaa", "active"), fakeChain("F20260801bbbb", "stalled")];
      const res = await makeController(chains).chains(makeCtx());
      const body = await res.json() as { chains: Array<{ featureId: string; state: string }>; stateCounts: Record<string, number>; total: number; fanInExcludedFiles: Array<{ file: string; fanIn: number }> };

      expect(body.total).toBe(2);
      expect(body.stateCounts).toEqual({ active: 1, stalled: 1 });
      expect(body.chains[0]).toMatchObject({ featureId: "F20260801aaaa", state: "active" });
      expect(Array.isArray(body.fanInExcludedFiles)).toBe(true);
    });

    it("链响应包含 docTitle 和 stateReason", async () => {
      const doc = { id: "F20260801aaaa", title: "健康面板综合分卡", status: "development", changeType: "feature", tags: [], modules: [], causalLinksFrom: [], supersedes: [], filePath: "", createdAt: null, createdInConversationId: null };
      const chains = [fakeChain("F20260801aaaa", "active", { doc, daysSinceLastCommit: 3 })];
      const res = await makeController(chains).chains(makeCtx());
      const body = await res.json() as { chains: Array<{ docTitle: string | null; stateReason: string }> };

      expect(body.chains[0].docTitle).toBe("健康面板综合分卡");
      expect(body.chains[0].stateReason).toContain("development");
      expect(body.chains[0].stateReason).toContain("3 天内有提交");
    });

    it("doc-only 链（daysSinceLastCommit=null）不显示 Infinity", async () => {
      const doc = { id: "F20260801cccc", title: "实验性特性", status: "draft", changeType: "feature", tags: [], modules: [], causalLinksFrom: [], supersedes: [], filePath: "", createdAt: null, createdInConversationId: null };
      const chains = [fakeChain("F20260801cccc", "stalled", { doc, daysSinceLastCommit: null })];
      const res = await makeController(chains).chains(makeCtx());
      const body = await res.json() as { chains: Array<{ stateReason: string }> };

      expect(body.chains[0].stateReason).not.toContain("Infinity");
      expect(body.chains[0].stateReason).toContain("无提交记录");
    });

    it("orphan 链 docTitle=null，stateReason 解释无文档", async () => {
      const chains = [fakeChain("F20260801dddd", "orphan")];
      const res = await makeController(chains).chains(makeCtx());
      const body = await res.json() as { chains: Array<{ docTitle: string | null; stateReason: string }> };

      expect(body.chains[0].docTitle).toBeNull();
      expect(body.chains[0].stateReason).toContain("未找到对应特性文档");
    });

    it("zombie doc-only 链 stateReason 不含 Infinity", async () => {
      const doc = { id: "F20260801eeee", title: "废弃特性", status: "proposed", changeType: "feature", tags: [], modules: [], causalLinksFrom: [], supersedes: [], filePath: "", createdAt: null, createdInConversationId: null };
      const chains = [fakeChain("F20260801eeee", "zombie", { doc, daysSinceLastCommit: null })];
      const res = await makeController(chains).chains(makeCtx());
      const body = await res.json() as { chains: Array<{ stateReason: string }> };

      expect(body.chains[0].stateReason).not.toContain("Infinity");
      expect(body.chains[0].stateReason).toContain("无提交记录");
    });
  });

  describe("chainDetail（Issue #644 新端点，审视发现 3）", () => {
    it("返回链详情：sha 截 8 位 / date Z 格式 ISO / changeType / filesChanged", async () => {
      const res = await makeController([fakeDetailChain()]).chainDetail(makeDetailCtx("F20260801aaaa"));
      expect(res.status).toBe(200);
      const body = await res.json() as { chain: { commits: Array<{ sha: string; date: string; changeType: string | null; filesChanged: string[] }>; stateReason: string; docStatus: string | null } };
      expect(body.chain.commits).toHaveLength(2);
      expect(body.chain.commits[0]!.sha).toBe("abcdef12"); // 16 位截 8 位
      expect(body.chain.commits[0]!.date).toBe("2026-08-10T00:00:00.000Z"); // toISOString 归一 Z 格式
      expect(body.chain.commits[1]!.changeType).toBe("BugFix");
      expect(body.chain.commits[0]!.filesChanged).toEqual(["a.ts"]);
      expect(body.chain.docStatus).toBe("development");
      expect(body.chain.stateReason).toBeTruthy();
    });

    it("不存在的链返回 404 与错误信息", async () => {
      const res = await makeController([fakeDetailChain()]).chainDetail(makeDetailCtx("F99999nope"));
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("chain not found");
      expect(body.error).toContain("F99999nope");
    });
  });

  describe("signals 证据透出（审视发现 3）", () => {
    it("evidenceDetail 安全解析：合法 JSON 透出对象，非法 JSON 降级 null 不阻断列表", async () => {
      // repo 层无非法 JSON 注入口（upsert stringify），直接 UPDATE 写入模拟历史脏数据
      signalRepo.upsert({ signalType: "bug_recurrence", severity: "critical", featureId: null, filePath: "src/x.ts", evidence: "e", suggestedAction: "s", evidenceDetail: { kind: "bug_recurrence_commits", windowDays: 30, commits: [{ sha: "ab12cd34", date: "2026-08-20T00:00:00.000Z", changeType: "BugFix", message: "m" }] }, confidence: "low" });
      // 模拟历史脏数据：evidence_detail 非合法 JSON
      const db0 = (signalRepo as unknown as { db: Database.Database }).db;
      db0.prepare("UPDATE signals SET evidence_detail = '{broken json' WHERE file_path = 'src/x.ts'").run();

      const res = await makeController().signals(makeCtx());
      const body = await res.json() as { signals: Array<{ evidenceDetail: unknown; confidence: string | null }> };
      expect(body.signals).toHaveLength(1);
      expect(body.signals[0]!.evidenceDetail).toBeNull(); // 降级不抛错
      expect(body.signals[0]!.confidence).toBe("low");
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

  describe("score", () => {
    it("空库返回 available:false 空态", async () => {
      const res = await makeController().score(makeCtx());
      const body = await res.json() as { available: boolean; dimensions: unknown[] };
      expect(body.available).toBe(false);
      expect(body.dimensions).toEqual([]);
    });

    it("有 health_index 行时返回五维 + overall + 归因 + 走向", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const meta = JSON.stringify({ overallStatus: "yellow", attribution: "架构稳定 0 分：热区文件拖累" });
      snapshotRepo.replaceForDate(today, [
        { snapshotDate: today, metricType: "health_index", metricKey: "D1", metricValue: 76.1 },
        { snapshotDate: today, metricType: "health_index", metricKey: "D2", metricValue: 0 },
        { snapshotDate: today, metricType: "health_index", metricKey: "D3", metricValue: 83.9 },
        { snapshotDate: today, metricType: "health_index", metricKey: "D4", metricValue: 74.4 },
        { snapshotDate: today, metricType: "health_index", metricKey: "D5", metricValue: 97.0 },
        { snapshotDate: today, metricType: "health_index", metricKey: "overall", metricValue: 66.8, metadata: meta },
      ]);

      const res = await makeController().score(makeCtx());
      const body = await res.json() as {
        available: boolean; snapshotDate: string;
        overall: number; overallStatus: string;
        dimensions: Array<{ dimension: string; name: string; score: number; status: string }>;
        trend: Record<string, unknown>; attribution: string;
      };
      expect(body.available).toBe(true);
      expect(body.snapshotDate).toBe(today);
      expect(body.overall).toBeCloseTo(66.8, 1);
      expect(body.overallStatus).toBe("yellow");
      expect(body.attribution).toContain("热区");
      expect(body.dimensions.map(d => d.dimension)).toEqual(["D1", "D2", "D3", "D4", "D5"]);
      expect(body.dimensions.find(d => d.dimension === "D2")!.status).toBe("red");
      expect(body.dimensions.find(d => d.dimension === "D1")!.status).toBe("green");
      expect(body.dimensions.find(d => d.dimension === "D4")!.status).toBe("yellow");
      // 单日数据不足 8 点 → 走向全 null（面板显示「—」）
      expect(body.trend["overall"]).toBeNull();
    });

    it("仅 cost_output 行时不受污染（available:false）", async () => {
      const today = new Date().toISOString().slice(0, 10);
      snapshotRepo.replaceForDate(today, [
        { snapshotDate: today, metricType: "cost_output", metricKey: "total_tokens", metricValue: 100 },
      ], "cost_output");
      const res = await makeController().score(makeCtx());
      const body = await res.json() as { available: boolean };
      expect(body.available).toBe(false);
    });
  });

  describe("scan", () => {
    it("手动扫描返回结果（#581 回修：响应体不再有 ok 字段）", async () => {
      const res = await makeController([], { commitCount: 42 }).scan(makeCtx());
      const body = await res.json() as { result: { commitCount: number }; ok?: boolean };
      expect(body.result.commitCount).toBe(42);
      expect(body.ok).toBeUndefined(); // ok 字段已随守门人语义废除
    });
  });
});

describe("RHI chains 轻量 commits（Issue #649 PR3）", () => {
  let db: Database.Database;
  let signalRepo: SignalRepository;
  let snapshotRepo: HealthSnapshotRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    migrateDatabase(db, console as never);
    signalRepo = new SignalRepository(db);
    snapshotRepo = new HealthSnapshotRepository(db);
  });

  const chainsController = (chains: FeatureChain[]): RhiController => {
    const worker = {
      buildChainsOnce: vi.fn(async () => chains),
      scanOnce: vi.fn(async () => ({ scannedAt: "", chainCount: 0, signalCount: 0, stored: 0, memoryIndexed: 0, wakeupsTriggered: 0, errors: [] })),
    } as unknown as RhiScanWorker;
    return new RhiController(snapshotRepo, signalRepo, worker, console as never);
  };

  it("列表链携带轻量 commits（sha8+date+changeType，无 message/filesChanged）", async () => {
    const chain: FeatureChain = {
      ...fakeChain("F20260801ffff", "regressed"),
      commits: [
        { sha: "abcdef1234567890", date: new Date("2026-08-10T00:00:00Z"), message: "feat: 引入", changeType: "New Feature", filesChanged: ["a.ts"], prNumber: null },
        { sha: "1234567890abcdef", date: new Date("2026-08-20T00:00:00Z"), message: "fix: 修复", changeType: "BugFix", filesChanged: ["a.ts"], prNumber: 123 },
      ],
    };
    const res = await chainsController([chain]).chains(makeCtx());
    const body = await res.json() as { chains: Array<{ commits: Array<Record<string, unknown>> }> };
    const lite = body.chains[0].commits;

    expect(lite).toHaveLength(2);
    expect(lite[0]).toEqual({ sha: "abcdef12", date: "2026-08-10T00:00:00.000Z", changeType: "New Feature" });
    expect(lite[1].sha).toBe("12345678");
    // 轻量化契约：不携带重量字段（全量走 chainDetail）
    expect(Object.keys(lite[0]).sort()).toEqual(["changeType", "date", "sha"]);
  });

  it("空 commits 链序列化为空数组（非 undefined）", async () => {
    const res = await chainsController([fakeChain("F20260801eeee", "zombie")]).chains(makeCtx());
    const body = await res.json() as { chains: Array<{ commits: unknown[] }> };

    expect(Array.isArray(body.chains[0].commits)).toBe(true);
    expect(body.chains[0].commits).toHaveLength(0);
  });
});

describe("RHI API 错误路径状态码（#581：废除守门人 200+error，catch 统一 5xx）", () => {
  /** 坏 repo：所有读方法抛错，模拟依赖层故障 */
  function badRepo(): never {
    const boom = () => { throw new Error("db exploded"); };
    return {
      findLatestByMetricKey: boom,
      findByDateRange: boom,
      findOpen: boom,
      findByStatus: boom,
      findActiveOtterIds: boom,
    } as never;
  }

  /** 坏 worker：buildChainsOnce/scanOnce 抛错 */
  function badWorker(): RhiScanWorker {
    const boom = async () => { throw new Error("git exploded"); };
    return { buildChainsOnce: boom, scanOnce: boom } as unknown as RhiScanWorker;
  }

  function makeErrController(): RhiController {
    return new RhiController(badRepo(), badRepo(), badWorker(), console as never);
  }

  it("overview 依赖抛错 → 500 + error body（非 200+error）", async () => {
    const res = await makeErrController().overview(makeStatusCtx());
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("db exploded");
  });

  it("signals 依赖抛错 → 500", async () => {
    const res = await makeErrController().signals(makeStatusCtx("open"));
    expect(res.status).toBe(500);
  });

  it("chains worker 抛错 → 500", async () => {
    const res = await makeErrController().chains(makeStatusCtx());
    expect(res.status).toBe(500);
  });

  it("chainDetail worker 抛错 → 500（正常 404 路径不受影响，另有用例覆盖）", async () => {
    const res = await makeErrController().chainDetail(makeStatusCtx(undefined, { featureId: "F1" }));
    expect(res.status).toBe(500);
  });

  it("trends 依赖抛错 → 500", async () => {
    const res = await makeErrController().trends(makeStatusCtx());
    expect(res.status).toBe(500);
  });

  it("score 依赖抛错 → 500", async () => {
    const res = await makeErrController().score(makeStatusCtx());
    expect(res.status).toBe(500);
  });

  it("costOutput 依赖抛错 → 500", async () => {
    const res = await makeErrController().costOutput(makeStatusCtx());
    expect(res.status).toBe(500);
  });

  it("scan worker 抛错 → 500（不再返回 200+ok:false）", async () => {
    const res = await makeErrController().scan(makeStatusCtx());
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("git exploded");
  });

  /** #581 回修（检视建议 2）：ADR 声称的 DomainError→4xx 自动映射，在 RHI 端点级佐证 */
  it("DomainError not_found 经 handleError → 404（ADR 4xx 映射在 RHI 端点真实生效）", async () => {
    const repo = {
      findLatestByMetricKey: () => { throw new DomainError("snapshot not found", "not_found"); },
      findByDateRange: () => [],
      findOpen: () => [],
      findByStatus: () => [],
      findActiveOtterIds: () => [],
    } as never;
    const worker = { buildChainsOnce: async () => [], scanOnce: async () => ({}) } as unknown as RhiScanWorker;
    const ctrl = new RhiController(repo, repo, worker, console as never);
    const res = await ctrl.overview(makeStatusCtx());
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("snapshot not found");
  });

  it("DomainError validation 经 handleError → 400（同一映射表的第二档佐证）", async () => {
    const repo = {
      findLatestByMetricKey: () => ({} as { snapshot_date: string; metric_value: number }),
      findByDateRange: () => { throw new DomainError("invalid date range", "validation"); },
      findOpen: () => [],
      findByStatus: () => [],
      findActiveOtterIds: () => [],
    } as never;
    const worker = { buildChainsOnce: async () => [], scanOnce: async () => ({}) } as unknown as RhiScanWorker;
    const ctrl = new RhiController(repo, repo, worker, console as never);
    const res = await ctrl.trends(makeStatusCtx());
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid date range");
  });
});
