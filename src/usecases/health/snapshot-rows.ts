/**
 * SnapshotRows: health_snapshots 行构建（共享逻辑，F20260829hviz）
 *
 * 抽自 HealthReport.persistMetrics——CLI（health-report.mjs）与 RhiScanWorker.scanOnce
 * 两条写入路径共用同一构建逻辑，保证口径一致（60 天滚动窗口）。
 *
 * 行清单（11 行）：overview 数值 7 行 + distribution 4 行（change_types / skip_reasons /
 * modules / file_hotspots）。RhiScanWorker 额外追加 chain_states 1 行（链构建只有 worker 有）。
 */

import type { Metrics } from "./metrics-calculator";

export interface SnapshotRowInput {
  snapshotDate: string;
  metrics: Metrics;
  /** 额外 distribution 行（如 worker 的 chain_states），追加在标准 11 行之后 */
  extraRows?: CreateSnapshotRow[];
}

/** 与 HealthSnapshotRepository.CreateHealthSnapshot 同构（避免循环依赖，字段级对齐） */
export interface CreateSnapshotRow {
  snapshotDate: string;
  metricType: string;
  metricKey: string;
  metricValue: number;
  metadata?: string;
}

/** 构建 health_snapshots 标准行集（HealthReport 既有口径，一比一迁移） */
export function buildOverviewSnapshotRows({ snapshotDate, metrics, extraRows }: SnapshotRowInput): CreateSnapshotRow[] {
  const rows: CreateSnapshotRow[] = [
    { snapshotDate, metricType: "overview", metricKey: "total_commits", metricValue: metrics.totalCommits },
    { snapshotDate, metricType: "overview", metricKey: "commits_with_fid", metricValue: metrics.commitsWithFid },
    { snapshotDate, metricType: "overview", metricKey: "compliant_commits", metricValue: metrics.compliantCommits },
    { snapshotDate, metricType: "overview", metricKey: "skipped_commits", metricValue: metrics.skippedCommits },
    { snapshotDate, metricType: "overview", metricKey: "bugfix_count", metricValue: metrics.bugfixCount },
    { snapshotDate, metricType: "overview", metricKey: "bugfix_ratio", metricValue: metrics.bugfixRatio },
    { snapshotDate, metricType: "overview", metricKey: "bugfix_ratio_of_fid", metricValue: metrics.bugfixRatioOfFid },
    {
      snapshotDate,
      metricType: "distribution",
      metricKey: "change_types",
      metricValue: metrics.compliantCommits,
      metadata: JSON.stringify(metrics.changeTypeDistribution),
    },
    {
      snapshotDate,
      metricType: "distribution",
      metricKey: "skip_reasons",
      metricValue: metrics.skippedCommits,
      metadata: JSON.stringify(metrics.skipReasonDistribution),
    },
    {
      snapshotDate,
      metricType: "distribution",
      metricKey: "modules",
      metricValue: metrics.moduleStats.reduce((s, m) => s + m.count, 0),
      metadata: JSON.stringify(metrics.moduleStats),
    },
    {
      snapshotDate,
      metricType: "distribution",
      metricKey: "file_hotspots",
      metricValue: metrics.fileHotspots.length,
      metadata: JSON.stringify(metrics.fileHotspots),
    },
  ];
  return extraRows ? [...rows, ...extraRows] : rows;
}
