import type { Logger } from "@usecases/ports/logger";
import type { FileSystemGateway } from "@usecases/ports/file-system-gateway";
import type Database from "better-sqlite3";
import { GitLogCollector } from "./git-log-collector";
import { CommitParser } from "./commit-parser";
import { FeatureDocCollector } from "./feature-doc-collector";
import { MetricsCalculator } from "./metrics-calculator";
import type { Metrics } from "./metrics-calculator";
import { HealthSnapshotRepository } from "./health-snapshot-repository";
import { CliReport } from "./cli-report";

export interface HealthReportOptions {
  format: "json" | "text" | "both";
  outputPath?: string;
  since?: string;
  until?: string;
  maxCount?: number;
}

/**
 * 健康报告主入口。
 * 整合所有组件，生成健康报告。
 */
export class HealthReport {
  private readonly gitLogCollector: GitLogCollector;
  private readonly commitParser: CommitParser;
  private readonly featureDocCollector: FeatureDocCollector;
  private readonly metricsCalculator: MetricsCalculator;
  private readonly healthSnapshotRepository: HealthSnapshotRepository;
  private readonly cliReport: CliReport;

  constructor(
    private readonly db: Database.Database,
    private readonly fs: FileSystemGateway,
    private readonly rootDir: string,
    private readonly logger: Logger,
  ) {
    this.gitLogCollector = new GitLogCollector(rootDir, logger);
    this.commitParser = new CommitParser(logger);
    this.featureDocCollector = new FeatureDocCollector(fs, rootDir, logger);
    this.metricsCalculator = new MetricsCalculator(logger);
    this.healthSnapshotRepository = new HealthSnapshotRepository(db, logger);
    this.cliReport = new CliReport(logger);
  }

  /**
   * 生成健康报告。
   * @param options 报告选项
   * @returns 报告内容
   */
  async generate(options: HealthReportOptions = { format: "both" }): Promise<string> {
    this.logger.info("Generating health report", { action: "health_report_start" });

    try {
      // 1. 采集 git log
      const commits = this.gitLogCollector.collect({
        since: options.since,
        until: options.until,
        maxCount: options.maxCount,
      });

      // 2. 解析提交消息
      const parsedCommits = commits.map(commit => this.commitParser.parse(commit.message));

      // 3. 采集特性文档（可选，用于后续分析）
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 特性文档采集器返回值暂未使用，后续信号引擎会用到
      const featureDocs = await this.featureDocCollector.collect();

      // 4. 计算指标
      const metrics = this.metricsCalculator.calculate(commits, parsedCommits);

      // 5. 持久化指标
      this.persistMetrics(metrics);

      // 6. 生成报告
      const report = this.cliReport.generate(metrics, options);

      this.logger.info("Health report generated", {
        action: "health_report_complete",
        totalCommits: metrics.totalCommits,
        bugfixRatio: metrics.bugfixRatio,
      });

      return report;
    } catch (error) {
      this.logger.error("Failed to generate health report", error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * 输出报告到控制台。
   * @param options 报告选项
   */
  async outputToConsole(options: HealthReportOptions = { format: "both" }): Promise<void> {
    const report = await this.generate(options);
    // eslint-disable-next-line no-console -- CLI 输出必须用 console
    console.log(report);
  }

  /**
   * 输出报告到文件。
   * @param outputPath 输出路径
   * @param options 报告选项
   */
  async outputToFile(outputPath: string, options: HealthReportOptions = { format: "both" }): Promise<void> {
    const report = await this.generate(options);

    try {
      const fs = await import("node:fs/promises");
      await fs.writeFile(outputPath, report, "utf-8");
      this.logger.info(`Report written to ${outputPath}`);
    } catch (error) {
      this.logger.error(`Failed to write report to ${outputPath}`, error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * 持久化指标。
   */
  private persistMetrics(metrics: Metrics): void {
    const snapshotDate = new Date().toISOString().split("T")[0];

    const snapshots = [
      {
        snapshotDate,
        metricType: "overview",
        metricKey: "total_commits",
        metricValue: metrics.totalCommits,
      },
      {
        snapshotDate,
        metricType: "overview",
        metricKey: "bugfix_count",
        metricValue: metrics.bugfixCount,
      },
      {
        snapshotDate,
        metricType: "overview",
        metricKey: "feature_count",
        metricValue: metrics.featureCount,
      },
      {
        snapshotDate,
        metricType: "overview",
        metricKey: "bugfix_ratio",
        metricValue: metrics.bugfixRatio,
      },
    ];

    this.healthSnapshotRepository.createBatch(snapshots);
  }
}
