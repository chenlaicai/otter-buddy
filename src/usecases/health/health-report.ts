/**
 * HealthReport: 健康报告主入口（Phase 0 MVP 集成）
 *
 * 管道：采集（git log + F 文档）→ 解析（CommitParser）→ 计算（MetricsCalculator）
 *      → 持久化（HealthSnapshotRepository）→ 输出（CliReport 双格式）
 *
 * Issue #394/#395/#396/#397 的集成层。
 */

import type Database from "better-sqlite3";
import type { Logger } from "@usecases/ports/logger";
import { collectGitLogWithFiles } from "./git-log-collector";
import { parseCommits } from "./commit-parser";
import { collectFeatureDocs } from "./feature-doc-collector";
import { calculateMetrics } from "./metrics-calculator";
import type { Metrics } from "./metrics-calculator";
import { HealthSnapshotRepository } from "./health-snapshot-repository";
import { generateReport } from "./cli-report";
import type { ReportFormat } from "./cli-report";

export interface HealthReportOptions {
  format: ReportFormat;
  since?: string;
  until?: string;
  maxCount?: number;
  /** 跳过持久化（CI/测试环境无写库需求时） */
  skipPersistence?: boolean;
}

export interface HealthReportResult {
  report: string;
  metrics: Metrics;
}

export class HealthReport {
  private readonly snapshotRepo: HealthSnapshotRepository;

  constructor(
    private readonly repoPath: string,
    private readonly db: Database.Database,
    private readonly logger: Logger,
  ) {
    this.snapshotRepo = new HealthSnapshotRepository(db);
  }

  /**
   * 生成健康报告（采集→解析→计算→持久化→输出）
   */
  async generate(options: HealthReportOptions): Promise<HealthReportResult> {
    const startedAt = Date.now();
    this.logger.info("Health report generation started", { action: "health_report_start" });

    // 1. 采集 git log（带文件列表）
    const commitsWithFiles = await collectGitLogWithFiles(this.repoPath, {
      since: options.since,
      until: options.until,
      maxCount: options.maxCount,
    });

    // 2. 解析 commit message
    const parsed = parseCommits(
      commitsWithFiles.map(({ sha, message }) => ({ sha, message })),
    );

    // 3. 采集 F 文档（Phase 0 校验覆盖率，Phase 1 特性链构建的数据源）
    const featureDocs = await collectFeatureDocs(this.repoPath);
    this.logger.info("Feature docs collected", {
      action: "health_report_docs",
      count: featureDocs.length,
    });

    // 4. 计算指标
    const metrics = calculateMetrics(parsed, commitsWithFiles);

    // 5. 持久化（快照表，同日重复运行覆盖式追加——按日期查询取最新）
    if (!options.skipPersistence) {
      this.persistMetrics(metrics);
    }

    // 6. 生成报告
    const report = generateReport(metrics, { format: options.format });

    this.logger.info("Health report generated", {
      action: "health_report_complete",
      totalCommits: metrics.totalCommits,
      bugfixRatio: Number(metrics.bugfixRatio.toFixed(4)),
      featureDocs: featureDocs.length,
      durationMs: Date.now() - startedAt,
    });

    return { report, metrics };
  }

  /**
   * 指标持久化到 health_snapshots。
   * overview 级指标逐条写入；分布类指标 JSON 序列化进 metadata。
   */
  private persistMetrics(metrics: Metrics): void {
    const snapshotDate = new Date().toISOString().slice(0, 10);

    this.snapshotRepo.createBatch([
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
    ]);
  }
}
