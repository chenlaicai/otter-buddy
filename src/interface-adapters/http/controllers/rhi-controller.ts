/**
 * RhiController: /api/health/* 端点（F20260825rweb Phase 2 / Issue #402）
 *
 * 三个读端点 + 一个手动扫描端点，数据全部来自 Phase 0/1 的现成结构：
 * - overview: health_snapshots 最新快照 + open 信号计数（含 critical 数）
 * - signals: signals 表（open 优先，可按 status 过滤）
 * - chains:  实时构建特性链（buildFeatureChains 纯函数，读 git + docs）
 * - scan:    手动触发一轮 RhiScanWorker.scanOnce（调试/演示用）
 *
 * 设计：try-catch 兜底返回 200 + error 字段（对齐 memory 端点的守门人模式）。
 */

import type { Context } from "hono";
import type { Logger } from "@usecases/ports/logger";
import type { SignalRepository } from "@usecases/health/signal-repository";
import type { HealthSnapshotRepository } from "@usecases/health/health-snapshot-repository";
import type { RhiScanWorker } from "@usecases/health/rhi-scan-worker";

const OVERVIEW_KEYS = [
  "total_commits", "commits_with_fid", "compliant_commits", "skipped_commits",
  "bugfix_count", "bugfix_ratio", "bugfix_ratio_of_fid",
] as const;

/** trends 序列指标键（F20260829hviz）：折线图趋势专用，比率 ×100 转百分比点位 */
const TREND_KEYS = [
  "total_commits", "bugfix_count", "bugfix_ratio", "compliant_commits",
] as const;

const DEFAULT_TREND_DAYS = 30;

/** 趋势序列聚合：{ date → { key → value } }，比率键 ×100 转百分比（F20260829hviz） */
const RATIO_KEYS = new Set(["bugfix_ratio", "bugfix_ratio_of_fid"]);

function aggregateTrendSeries(rows: Array<{ snapshot_date: string; metric_key: string; metric_value: number }>):
  Array<Record<string, number | string>> {
  const byDate = new Map<string, Record<string, number>>();
  for (const row of rows) {
    if (!TREND_KEYS.includes(row.metric_key as (typeof TREND_KEYS)[number])) continue;
    const point = byDate.get(row.snapshot_date) ?? {};
    point[row.metric_key] = RATIO_KEYS.has(row.metric_key)
      ? Number((row.metric_value * 100).toFixed(2))
      : row.metric_value;
    byDate.set(row.snapshot_date, point);
  }
  return [...byDate.entries()]
    .map(([date, values]) => ({ date, ...values }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 最新一天 distribution 行解析为 { key → parsed JSON }（metadata 坏 JSON 降级 null） */
function parseLatestDistributions(
  rows: Array<{ snapshot_date: string; metric_type: string; metric_key: string; metadata: string | null }>,
  latestDate: string | null,
): Record<string, unknown> {
  if (!latestDate) return {};
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    if (r.metric_type !== "distribution" || r.snapshot_date !== latestDate) continue;
    try {
      out[r.metric_key] = r.metadata ? JSON.parse(r.metadata) : null;
    } catch {
      out[r.metric_key] = null;
    }
  }
  return out;
}

/** cost_output 趋势序列构建（#583） */
function buildCostTrendSeries(
  costRows: Array<{ snapshot_date: string; metric_key: string; metric_value: number }>,
): Array<Record<string, number | string>> {
  const AGGREGATE_KEYS = new Set(["total_tokens", "cost_total", "llm_call_count", "message_count"]);
  const byDate = new Map<string, Record<string, number>>();
  for (const row of costRows) {
    const point = byDate.get(row.snapshot_date) ?? {};
    if (AGGREGATE_KEYS.has(row.metric_key)) {
      point[row.metric_key] = (point[row.metric_key] ?? 0) + row.metric_value;
    } else if (row.metric_key === "cache_hit_rate") {
      point._cache_hit_sum = (point._cache_hit_sum ?? 0) + row.metric_value;
      point._cache_hit_n = (point._cache_hit_n ?? 0) + 1;
    }
    byDate.set(row.snapshot_date, point);
  }
  return [...byDate.entries()]
    .map(([date, p]) => ({
      date,
      total_tokens: p.total_tokens ?? 0,
      cost_total: p.cost_total ?? 0,
      llm_call_count: p.llm_call_count ?? 0,
      cache_hit_rate: p._cache_hit_n ? Number(((p._cache_hit_sum ?? 0) / p._cache_hit_n * 100).toFixed(2)) : 0,
      message_count: p.message_count ?? 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** cost_output per-otter 聚合（#583）：从最新一天的行提取 otter 明细 */
/** 从最新一天的行提取 otter 明细（#583） */
function buildCostOtterBreakdown(
  latestRows: Array<{ metric_key: string; metric_value: number; metadata: string | null }>,
): Array<{
  otterId: string; otterName: string; otterType: string;
  totalTokens: number; costTotal: number; callCount: number;
  cacheHitRate: number; messageCount: number;
  models: Array<{ model: string; totalTokens: number; costTotal: number }>;
}> {
  const otterMap = new Map<string, OtterAcc>();
  for (const row of latestRows) {
    const meta = row.metadata ? JSON.parse(row.metadata) as { otterId?: string; otterName?: string; otterType?: string; model?: string } : {};
    const entry = getOrInitOtter(otterMap, meta);
    applyMetricValue(entry, row.metric_key, row.metric_value);
    if (meta.model && MODEL_COST_KEYS.has(row.metric_key)) {
      accumulateModel(entry.models, meta.model, row.metric_key, row.metric_value);
    }
  }
  return [...otterMap.values()].map(formatOtterEntry).sort((a, b) => b.costTotal - a.costTotal);
}

type OtterAcc = {
  otterId: string; otterName: string; otterType: string;
  totalTokens: number; costTotal: number; callCount: number;
  cacheHitRate: number; messageCount: number;
  models: Map<string, { totalTokens: number; costTotal: number }>;
};
const MODEL_COST_KEYS = new Set(["total_tokens", "cost_total"]);
const KEY_FIELD: Record<string, "totalTokens" | "costTotal" | "callCount" | "cacheHitRate" | "messageCount"> = {
  total_tokens: "totalTokens", cost_total: "costTotal",
  llm_call_count: "callCount", cache_hit_rate: "cacheHitRate", message_count: "messageCount",
};
function getOrInitOtter(map: Map<string, OtterAcc>, meta: { otterId?: string; otterName?: string; otterType?: string }): OtterAcc {
  const id = meta.otterId ?? "unknown";
  let entry = map.get(id);
  if (!entry) {
    entry = { otterId: id, otterName: meta.otterName ?? id, otterType: meta.otterType ?? "unknown", totalTokens: 0, costTotal: 0, callCount: 0, cacheHitRate: 0, messageCount: 0, models: new Map() };
    map.set(id, entry);
  }
  return entry;
}
function applyMetricValue(entry: OtterAcc, key: string, value: number): void {
  const field = KEY_FIELD[key];
  if (!field) return;
  if (field === "cacheHitRate") { entry.cacheHitRate = value; } else { entry[field] = (entry[field] as number) + value; }
}
function accumulateModel(models: Map<string, { totalTokens: number; costTotal: number }>, model: string, key: string, value: number): void {
  let m = models.get(model);
  if (!m) { m = { totalTokens: 0, costTotal: 0 }; models.set(model, m); }
  if (key === "total_tokens") m.totalTokens += value;
  if (key === "cost_total") m.costTotal += value;
}
function formatOtterEntry(e: OtterAcc) {
  return {
    otterId: e.otterId, otterName: e.otterName, otterType: e.otterType,
    totalTokens: e.totalTokens, costTotal: Number(e.costTotal.toFixed(6)),
    callCount: e.callCount, cacheHitRate: Number(e.cacheHitRate.toFixed(4)), messageCount: e.messageCount,
    models: [...e.models.entries()].map(([model, m]) => ({
      model, totalTokens: m.totalTokens, costTotal: Number(m.costTotal.toFixed(6)),
    })).sort((a, b) => b.costTotal - a.costTotal),
  };
}

export class RhiController {
  constructor(
    private readonly snapshotRepo: HealthSnapshotRepository,
    private readonly signalRepo: SignalRepository,
    private readonly scanWorker: RhiScanWorker,
    private readonly logger: Logger,
  ) {}

  /** GET /api/health/overview — 总览：最新快照指标 + 信号计数 */
  async overview(c: Context): Promise<Response> {
    try {
      const metrics: Record<string, number> = {};
      for (const key of OVERVIEW_KEYS) {
        const snap = this.snapshotRepo.findLatestByMetricKey(key);
        if (snap) metrics[key] = snap.metric_value;
      }

      const openSignals = this.signalRepo.findOpen();
      const bySeverity = { critical: 0, warning: 0 };
      for (const s of openSignals) {
        if (s.severity === "critical") bySeverity.critical++;
        else bySeverity.warning++;
      }

      const latestSnapshotDate = this.snapshotRepo.findLatestByMetricKey("total_commits")?.snapshot_date ?? null;

      return c.json({
        metrics,
        snapshotDate: latestSnapshotDate,
        openSignals: openSignals.length,
        openSignalsBySeverity: bySeverity,
      });
    } catch (err) {
      this.logger.error("RHI overview failed", err instanceof Error ? err : undefined);
      return c.json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** GET /api/health/signals?status=open — 信号列表 */
  async signals(c: Context): Promise<Response> {
    try {
      const status = c.req.query("status") ?? "open";
      const rows = status === "all"
        ? [...this.signalRepo.findOpen(), ...this.signalRepo.findByStatus("resolved"), ...this.signalRepo.findByStatus("dismissed")]
        : this.signalRepo.findByStatus(status);
      return c.json({ signals: rows, count: rows.length });
    } catch (err) {
      this.logger.error("RHI signals failed", err instanceof Error ? err : undefined);
      return c.json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** GET /api/health/chains — 特性链列表（实时构建，含五态分布） */
  async chains(c: Context): Promise<Response> {
    try {
      const chains = await this.scanWorker.buildChainsOnce();
      const stateCounts: Record<string, number> = {};
      for (const ch of chains) {
        stateCounts[ch.state] = (stateCounts[ch.state] ?? 0) + 1;
      }
      return c.json({
        chains: chains.map(ch => ({
          featureId: ch.featureId,
          state: ch.state,
          commitCount: ch.commitCount,
          bugfixCount: ch.bugfixCount,
          daysSinceLastCommit: ch.daysSinceLastCommit,
          firstSeenAt: ch.firstSeenAt,
          lastCommitAt: ch.lastCommitAt,
          docStatus: ch.doc?.status ?? null,
        })),
        stateCounts,
        total: chains.length,
      });
    } catch (err) {
      this.logger.error("RHI chains failed", err instanceof Error ? err : undefined);
      return c.json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** GET /api/health/trends?days=30 — 历史趋势序列（F20260829hviz）
   *  从 health_snapshots 按日期范围拉取趋势指标 + 最新一天的 distribution 行
   *  （change_types / modules / chain_states，供环形图/堆叠条/条形图）。 */
  async trends(c: Context): Promise<Response> {
    try {
      const days = Math.min(Math.max(Number(c.req.query("days")) || DEFAULT_TREND_DAYS, 1), 90);
      const startDate = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);

      const rows = this.snapshotRepo.findByDateRange(startDate, new Date().toISOString().slice(0, 10));
      const series = aggregateTrendSeries(rows);
      const latestDate = rows.length > 0 ? rows[rows.length - 1]!.snapshot_date : null;
      const distributions = parseLatestDistributions(rows, latestDate);

      return c.json({
        days,
        series,
        distributions,
        latestSnapshotDate: latestDate,
      });
    } catch (err) {
      this.logger.error("RHI trends failed", err instanceof Error ? err : undefined);
      return c.json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** GET /api/health/cost-output?days=30 — 成本/产出趋势序列（#583）
   *  从 health_snapshots 按日期范围拉取 cost_output 指标，聚合出：
   *  - per-date 趋势（总 token / 总 cost / 调用数 / 缓存命中率 / 产出数）
   *  - per-otter 明细（最新一天的 per-otter per-model 拆分）
   *  - 汇总（最新一天的总计）
   *  成本/产出只作信号不作 KPI（Goodhart 防线）。 */
  async costOutput(c: Context): Promise<Response> {
    try {
      const days = Math.min(Math.max(Number(c.req.query("days")) || DEFAULT_TREND_DAYS, 1), 90);
      const startDate = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const endDate = new Date().toISOString().slice(0, 10);

      const costRows = this.snapshotRepo.findByDateRange(startDate, endDate).filter(r => r.metric_type === "cost_output");
      const series = buildCostTrendSeries(costRows);

      const latestDate = costRows.length > 0
        ? [...costRows].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))[costRows.length - 1]!.snapshot_date
        : null;
      const otters = latestDate ? buildCostOtterBreakdown(costRows.filter(r => r.snapshot_date === latestDate)) : [];

      const totals = {
        totalTokens: otters.reduce((s, o) => s + o.totalTokens, 0),
        costTotal: Number(otters.reduce((s, o) => s + o.costTotal, 0).toFixed(6)),
        callCount: otters.reduce((s, o) => s + o.callCount, 0),
        messageCount: otters.reduce((s, o) => s + o.messageCount, 0),
        otterCount: otters.length,
      };

      return c.json({ days, series, otters, totals, latestSnapshotDate: latestDate });
    } catch (err) {
      this.logger.error("RHI cost-output failed", err instanceof Error ? err : undefined);
      return c.json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** POST /api/health/scan — 手动触发一轮扫描（调试/演示；worker 每小时自动跑） */
  async scan(c: Context): Promise<Response> {
    try {
      const result = await this.scanWorker.scanOnce();
      return c.json({ ok: true, result });
    } catch (err) {
      this.logger.error("RHI manual scan failed", err instanceof Error ? err : undefined);
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
