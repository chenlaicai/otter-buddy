import type { GitCommit } from "./git-log-collector";
import type { ParsedCommit } from "./commit-parser";
import type { Logger } from "@usecases/ports/logger";

export interface Metrics {
  totalCommits: number;
  bugfixCount: number;
  bugfixRatio: number;
  featureCount: number;
  moduleDistribution: Record<string, number>;
  fileHotspots: Array<{ file: string; count: number }>;
  topModules: Array<{ module: string; count: number }>;
}

/**
 * 核心指标计算器。
 * 全确定性，无 LLM。
 */
export class MetricsCalculator {
  constructor(private readonly logger: Logger) {}

  /**
   * 计算指标。
   * @param commits 提交列表
   * @param parsedCommits 解析后的提交列表
   * @returns 指标
   */
  calculate(commits: GitCommit[], parsedCommits: ParsedCommit[]): Metrics {
    const totalCommits = commits.length;

    // 统计 bugfix 数量
    const bugfixCount = parsedCommits.filter(
      commit => commit.changeType === "bugfix"
    ).length;

    // 统计 feature 数量
    const featureCount = parsedCommits.filter(
      commit => commit.changeType === "feature"
    ).length;

    // 计算 bugfix 比率
    const bugfixRatio = totalCommits > 0 ? bugfixCount / totalCommits : 0;

    // 统计模块分布
    const moduleDistribution: Record<string, number> = {};
    for (const commit of parsedCommits) {
      if (commit.module) {
        moduleDistribution[commit.module] = (moduleDistribution[commit.module] || 0) + 1;
      }
    }

    // 统计文件热点
    const fileCounts: Record<string, number> = {};
    for (const commit of commits) {
      for (const file of commit.filesChanged) {
        fileCounts[file] = (fileCounts[file] || 0) + 1;
      }
    }

    // 排序文件热点
    const fileHotspots = Object.entries(fileCounts)
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20); // TOP 20

    // 排序模块热区
    const topModules = Object.entries(moduleDistribution)
      .map(([module, count]) => ({ module, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalCommits,
      bugfixCount,
      bugfixRatio,
      featureCount,
      moduleDistribution,
      fileHotspots,
      topModules,
    };
  }

  /**
   * 计算增量指标。
   * @param newCommits 新提交
   * @param existingMetrics 现有指标
   * @returns 更新后的指标
   */
  calculateIncremental(
    newCommits: GitCommit[],
    newParsedCommits: ParsedCommit[],
    existingMetrics: Metrics,
  ): Metrics {
    const totalCommits = existingMetrics.totalCommits + newCommits.length;

    const bugfixCount =
      existingMetrics.bugfixCount +
      newParsedCommits.filter(commit => commit.changeType === "bugfix").length;

    const featureCount =
      existingMetrics.featureCount +
      newParsedCommits.filter(commit => commit.changeType === "feature").length;

    const bugfixRatio = totalCommits > 0 ? bugfixCount / totalCommits : 0;

    // 合并模块分布
    const moduleDistribution = { ...existingMetrics.moduleDistribution };
    for (const commit of newParsedCommits) {
      if (commit.module) {
        moduleDistribution[commit.module] = (moduleDistribution[commit.module] || 0) + 1;
      }
    }

    // 合并文件热点
    const fileCounts: Record<string, number> = {};
    for (const commit of newCommits) {
      for (const file of commit.filesChanged) {
        fileCounts[file] = (fileCounts[file] || 0) + 1;
      }
    }

    // 合并现有文件热点
    for (const { file, count } of existingMetrics.fileHotspots) {
      fileCounts[file] = (fileCounts[file] || 0) + count;
    }

    const fileHotspots = Object.entries(fileCounts)
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const topModules = Object.entries(moduleDistribution)
      .map(([module, count]) => ({ module, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalCommits,
      bugfixCount,
      bugfixRatio,
      featureCount,
      moduleDistribution,
      fileHotspots,
      topModules,
    };
  }
}
