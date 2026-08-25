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
