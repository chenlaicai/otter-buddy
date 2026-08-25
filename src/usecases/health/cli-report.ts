/**
 * CliReport: CLI 报告生成（Issue #397）
 *
 * JSON + 可读文本双格式输出。纯函数，无 IO——输出动作由调用方（脚本层）执行。
 */

import type { Metrics } from "./metrics-calculator";

export type ReportFormat = "json" | "text" | "both";

export interface ReportOptions {
  format: ReportFormat;
}

/** 段落渲染辅助：标题 + 逐行 key: value */
function renderSection(title: string, rows: string[]): string[] {
  return [`[${title}]`, ...rows.map(r => `  ${r}`), ""];
}

/** 生成可读文本报告 */
export function generateTextReport(metrics: Metrics): string {
  const lines: string[] = ["=== RHI 健康报告 ===", ""];

  lines.push(...renderSection("总览", [
    `总提交数（含 merge/init）: ${metrics.totalCommits}`,
    `有 FID 的提交数: ${metrics.commitsWithFid}`,
    `严格三段格式合规: ${metrics.compliantCommits}`,
    `显式跳过（skip-with-reason）: ${metrics.skippedCommits}`,
    `BugFix 数量: ${metrics.bugfixCount}`,
    `BugFix 比率（/总提交）: ${(metrics.bugfixRatio * 100).toFixed(1)}%`,
    `BugFix 比率（/有 FID 提交）: ${(metrics.bugfixRatioOfFid * 100).toFixed(1)}%`,
  ]));

  lines.push(...renderSection(
    "变更类型分布",
    Object.entries(metrics.changeTypeDistribution).map(([type, count]) => `${type}: ${count}`),
  ));

  if (Object.keys(metrics.skipReasonDistribution).length > 0) {
    lines.push(...renderSection(
      "不合规分布（skip-with-reason）",
      Object.entries(metrics.skipReasonDistribution).map(([reason, count]) => `${reason}: ${count}`),
    ));
  }

  lines.push(...renderSection(
    "模块热区",
    metrics.moduleStats.map(({ module, count }) => `${module}: ${count}`),
  ));

  lines.push(...renderSection(
    `文件热点 TOP ${metrics.fileHotspots.length}`,
    metrics.fileHotspots.map(({ file, count }) => `${file}: ${count}`),
  ));

  lines.push("=== 报告结束 ===");
  return lines.join("\n");
}

/** 生成 JSON 报告（agent 可消费通道） */
export function generateJsonReport(metrics: Metrics): string {
  return JSON.stringify(metrics, null, 2);
}

/** 按格式生成报告 */
export function generateReport(metrics: Metrics, options: ReportOptions): string {
  switch (options.format) {
    case "json":
      return generateJsonReport(metrics);
    case "text":
      return generateTextReport(metrics);
    case "both":
      return `${generateTextReport(metrics)}\n--- JSON ---\n${generateJsonReport(metrics)}`;
  }
}
