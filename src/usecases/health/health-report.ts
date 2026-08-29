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
import { buildOverviewSnapshotRows } from "./snapshot-rows";
import { generateReport } from "./cli-report";
import type { ReportFormat } from "./cli-report";

export interface HealthReportOptions {
  format: ReportFormat;
  since?: string;
  until?: string;
  maxCount?: number;
  /** 跳过持久化（CI/测试环境无写库需求时） */
  skipPersistence?: boolean;
  /** 快照日期（默认今天；回填历史用，F20260829hviz） */
  snapshotDate?: string;
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

    // 5. 持久化（同日 DELETE+INSERT 覆盖，对抗审视发现 4：消费方无需理解"取最新"）
    if (!options.skipPersistence) {
      this.snapshotRepo.replaceForDate(
        options.snapshotDate ?? new Date().toISOString().slice(0, 10),
        buildOverviewSnapshotRows({
          snapshotDate: options.snapshotDate ?? new Date().toISOString().slice(0, 10),
          metrics,
        }),
      );
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
}
