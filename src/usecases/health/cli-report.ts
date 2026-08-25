import type { Metrics } from "./metrics-calculator";
import type { Logger } from "@usecases/ports/logger";

export interface ReportOptions {
  format: "json" | "text" | "both";
  outputPath?: string;
}

/**
 * CLI 报告工具。
 * 输出 JSON + 可读文本双格式。
 */
export class CliReport {
  constructor(private readonly logger: Logger) {}

  /**
   * 生成报告。
   * @param metrics 指标
   * @param options 报告选项
   * @returns 报告内容
   */
  generate(metrics: Metrics, options: ReportOptions = { format: "both" }): string {
    const { format } = options;

    if (format === "json") {
      return this.generateJson(metrics);
    } else if (format === "text") {
      return this.generateText(metrics);
    } else {
      return this.generateBoth(metrics);
    }
  }

  /**
   * 生成 JSON 报告。
   */
  private generateJson(metrics: Metrics): string {
    return JSON.stringify(metrics, null, 2);
  }

  /**
   * 生成文本报告。
   */
  private generateText(metrics: Metrics): string {
    const lines: string[] = [];

    lines.push("=== RHI 健康报告 ===");
    lines.push("");
    lines.push(`总提交数: ${metrics.totalCommits}`);
    lines.push(`Bugfix 数量: ${metrics.bugfixCount}`);
    lines.push(`Feature 数量: ${metrics.featureCount}`);
    lines.push(`Bugfix 比率: ${(metrics.bugfixRatio * 100).toFixed(1)}%`);
    lines.push("");

    lines.push("--- 模块热区 ---");
    for (const { module, count } of metrics.topModules) {
      lines.push(`  ${module}: ${count}`);
    }
    lines.push("");

    lines.push("--- 文件热点 TOP 10 ---");
    const top10Files = metrics.fileHotspots.slice(0, 10);
    for (const { file, count } of top10Files) {
      lines.push(`  ${file}: ${count}`);
    }
    lines.push("");

    lines.push("=== 报告结束 ===");

    return lines.join("\n");
  }

  /**
   * 生成双格式报告。
   */
  private generateBoth(metrics: Metrics): string {
    const json = this.generateJson(metrics);
    const text = this.generateText(metrics);

    return `${text}\n\n--- JSON 格式 ---\n${json}`;
  }

  /**
   * 输出报告到控制台。
   * @param metrics 指标
   * @param options 报告选项
   */
  outputToConsole(metrics: Metrics, options: ReportOptions = { format: "both" }): void {
    const report = this.generate(metrics, options);
    // eslint-disable-next-line no-console -- CLI 输出必须用 console
    console.log(report);
  }

  /**
   * 输出报告到文件。
   * @param metrics 指标
   * @param outputPath 输出路径
   * @param options 报告选项
   */
  async outputToFile(
    metrics: Metrics,
    outputPath: string,
    options: ReportOptions = { format: "both" },
  ): Promise<void> {
    const report = this.generate(metrics, options);

    try {
      const fs = await import("node:fs/promises");
      await fs.writeFile(outputPath, report, "utf-8");
      this.logger.info(`Report written to ${outputPath}`);
    } catch (error) {
      this.logger.error(`Failed to write report to ${outputPath}`, error instanceof Error ? error : undefined);
      throw error;
    }
  }
}
