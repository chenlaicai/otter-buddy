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
import { judgeTrend, DIMENSION_NAMES, statusFromScore } from "@usecases/health/health-score";
import type { DimensionId, TrendDirection } from "@usecases/health/health-score";

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

/** 最新一天 health_index 行 → 维度列表 + overall 归因元数据 */
function parseLatestHealthIndex(
  rows: Array<{ snapshot_date: string; metric_key: string; metric_value: number; metadata: string | null }>,
  latestDate: string,
): {
  dims: Array<{ dimension: DimensionId; name: string; score: number; status: string }>;
  overallScore: number | null;
  overallMeta: { attribution?: string | null; overallStatus?: string } | null;
} {
  const dims: Array<{ dimension: DimensionId; name: string; score: number; status: string }> = [];
  let overallScore: number | null = null;
  let overallMeta: { attribution?: string | null; overallStatus?: string } | null = null;
  for (const r of rows) {
    if (r.snapshot_date !== latestDate) continue;
    if (r.metric_key === "overall") {
      overallScore = r.metric_value;
      try {
        overallMeta = r.metadata ? JSON.parse(r.metadata) : null;
      } catch {
        overallMeta = null;
      }
      continue;
    }
    dims.push({
      dimension: r.metric_key as DimensionId,
      name: DIMENSION_NAMES[r.metric_key as DimensionId] ?? r.metric_key,
      score: r.metric_value,
      status: statusFromScore(r.metric_value),
    });
  }
  return { dims, overallScore, overallMeta };
}

/** 每维 + overall 的近 14 天序列 → 走向判定 */
function judgeTrends(
  rows: Array<{ snapshot_date: string; metric_key: string; metric_value: number }>,
  dimensionKeys: string[],
): Partial<Record<DimensionId | "overall", TrendDirection | null>> {
  const trend: Partial<Record<DimensionId | "overall", TrendDirection | null>> = {};
  for (const key of dimensionKeys) {
    const series = rows
      .filter(r => r.metric_key === key)
      .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))
      .map(r => r.metric_value);
    trend[key as DimensionId | "overall"] = judgeTrend(series);
  }
  return trend;
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

  /** GET /api/health/score — 健康指标（issue #595 PR1）：最新维度分 + 状态 + 走向 + 拖累归因
   *  数据源 health_index 行（worker 旁路写入）；未上线路径返回空态（面板显示「—」）。 */
  async score(c: Context): Promise<Response> {
    try {
      const startDate = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const rows = this.snapshotRepo
        .findByDateRange(startDate, new Date().toISOString().slice(0, 10))
        .filter(r => r.metric_type === "health_index");

      if (rows.length === 0) {
        return c.json({ available: false, dimensions: [], trend: {}, attribution: null });
      }

      const latestDate = rows[rows.length - 1]!.snapshot_date;
      const { dims, overallScore, overallMeta } = parseLatestHealthIndex(rows, latestDate);
      const trend = judgeTrends(rows, [...dims.map(d => d.dimension), "overall"]);

      return c.json({
        available: true,
        snapshotDate: latestDate,
        overall: overallScore,
        overallStatus: overallMeta?.overallStatus ?? (overallScore !== null ? statusFromScore(overallScore) : null),
        dimensions: dims,
        trend,
        attribution: overallMeta?.attribution ?? null,
      });
    } catch (err) {
      this.logger.error("RHI score failed", err instanceof Error ? err : undefined);
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
