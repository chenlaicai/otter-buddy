/**
 * MetricsCalculator: 核心指标计算（Issue #395）
 *
 * 全确定性、无 LLM。口径对齐特性文档 F20260824rhib 的实测数字：
 * - bugfix 比率分母 = 有 FID 的 commit（含非标准格式），merge/init 等无 FID 者不计
 *   （实测口径 72/259 ≈ 27.8% 中的 259 为全部 commit，其中带 F 前缀 249；
 *    MVP 用 FID 口径，CLI 报告中同时输出两个口径供校对）
 * - 模块热区 = 合规 commit 按 module 段聚合（实测 agent 67 / skills 25 / web 22）
 * - 文件热点 = git log --name-only 聚合（实测 conversation/index.tsx 19 次）
 */

import type { ParsedCommit } from "./commit-parser";
import type { GitCommitWithFiles } from "./git-log-collector";

export interface FileHotspot {
  file: string;
  count: number;
}

export interface ModuleStat {
  module: string;
  count: number;
}

export interface Metrics {
  /** 全部 commit 数（含 merge/init 等不合规） */
  totalCommits: number;
  /** 有 FID 的 commit 数（标准 + 非标准格式） */
  commitsWithFid: number;
  /** 合规 commit 数（严格三段格式） */
  compliantCommits: number;
  /** 不合规 commit 数（有 skipReason 且无 FID） */
  skippedCommits: number;
  /** bugfix 数（changeType=BugFix） */
  bugfixCount: number;
  /** bugfix 占 totalCommits 的比率（复现实测 27.8% 口径） */
  bugfixRatio: number;
  /** bugfix 占有 FID commit 的比率 */
  bugfixRatioOfFid: number;
  /** 各 changeType 分布 */
  changeTypeDistribution: Record<string, number>;
  /** 各 skipReason 分布（显式 skip-with-reason） */
  skipReasonDistribution: Record<string, number>;
  /** 模块热区排行（降序） */
  moduleStats: ModuleStat[];
  /** 文件热点 TOP N（降序） */
  fileHotspots: FileHotspot[];
}

export interface MetricsOptions {
  /** 文件热点取前 N，默认 20 */
  hotspotTopN?: number;
}

/** 计数辅助：按 key 聚合 */
function tally<T>(items: T[], keyOf: (item: T) => string | null): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    if (key) {
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

/** 文件热点：从 commit 文件列表聚合出 TOP N */
function computeFileHotspots(
  commitsWithFiles: GitCommitWithFiles[],
  topN: number,
): FileHotspot[] {
  const fileCounts = tally(
    commitsWithFiles.flatMap(c => c.filesChanged),
    f => f,
  );
  return Object.entries(fileCounts)
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
    .slice(0, topN);
}

/** 模块热区：按 module 段聚合（降序，同频按名排序） */
function computeModuleStats(parsed: ParsedCommit[]): ModuleStat[] {
  const moduleCounts = tally(parsed, p => p.module);
  return Object.entries(moduleCounts)
    .map(([module, count]) => ({ module, count }))
    .sort((a, b) => b.count - a.count || a.module.localeCompare(b.module));
}

/**
 * 计算核心指标（纯函数）
 * @param parsed parseCommits 的解析结果（与 commitsWithFiles 按 sha 对齐）
 * @param commitsWithFiles 带文件变更列表的 commit
 */
export function calculateMetrics(
  parsed: ParsedCommit[],
  commitsWithFiles: GitCommitWithFiles[],
  options: MetricsOptions = {},
): Metrics {
  const topN = options.hotspotTopN ?? 20;

  const totalCommits = parsed.length;
  const commitsWithFid = parsed.filter(p => p.featureId !== null).length;
  const compliantCommits = parsed.filter(p => p.isCompliant).length;
  const skippedCommits = parsed.filter(p => !p.isCompliant && !p.featureId).length;

  const bugfixCount = parsed.filter(p => p.changeType === "BugFix").length;
  const bugfixRatio = totalCommits > 0 ? bugfixCount / totalCommits : 0;
  const bugfixRatioOfFid = commitsWithFid > 0 ? bugfixCount / commitsWithFid : 0;

  return {
    totalCommits,
    commitsWithFid,
    compliantCommits,
    skippedCommits,
    bugfixCount,
    bugfixRatio,
    bugfixRatioOfFid,
    changeTypeDistribution: tally(parsed, p => p.changeType),
    skipReasonDistribution: tally(parsed, p => p.skipReason ?? null),
    moduleStats: computeModuleStats(parsed),
    fileHotspots: computeFileHotspots(commitsWithFiles, topN),
  };
}
