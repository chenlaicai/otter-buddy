/**
 * PostMergeFixDensityDetector: 合并后修复密度检测（Issue #647 改动清单第 6 项）
 *
 * 问题：「特性合入后 N 天内还在反复修」是「特性本身不对劲」的模式——但现有信号
 * （bug_recurrence 文件级 / chain_stall 链级滞留）都不回答「哪个特性合入后出血最重」。
 *
 * 检测口径（Issue #647 三条边界，合议补全）：
 * 1. 合入时刻 = FID 最后 main commit（squash 流近似——合并后 FID 的修复 commit
 *    落在合入 commit 之后，最后一个 main commit 近似合入点）
 * 2. 窗口按链规模分档：小链（commits ≤10）14 天 / 中链（≤30）21 天 / 大链 30 天——
 *    大特性合入后返工周期天然更长，一刀切小窗口会对大特性误报
 * 3. 高扇入文件排除：被 ≥5 个特性链触碰过的文件（如 app.ts 被 19 个特性碰过）进
 *    排除清单，不参与链级 bugfix 计数与占比——这些文件上的 bugfix 归因不到单一特性，
 *    文件级出血由 bug_recurrence 兜底（无排除）。排除清单写入 evidence_detail（不黑箱）
 *
 * 触发条件（满足其一）：
 * - 窗口内触碰链文件（排除清单后）的 BugFix commit ≥3 次
 * - 占比 ≥30%：分母 = 窗口内触碰链文件（排除后）的全部相关 commit（含链自身）
 *
 * 显式契约（与 bug_recurrence 的分工）：本检测器链级、带排除清单，抓「哪个特性不对劲」；
 * bug_recurrence 文件级、无排除，抓「哪里在出血」。app.ts 反复出 bug 由文件级兜底报。
 *
 * 全确定性纯函数，无 LLM（与信号引擎同一哲学）。
 */

import type { ParsedCommit } from "./commit-parser";
import type { FeatureChain } from "./chain-builder";
import { SIGNAL_REGISTRY } from "./signal-registry";
import type { DetectedSignal, PostMergeFixDensityDetail } from "./detect-signals";

export type { PostMergeFixDensityDetail };

/** 高扇入排除阈值：被 ≥N 条特性链触碰的文件进排除清单 */
export const HIGH_FANIN_THRESHOLD = 5;

/** 触发次数阈值（窗口内触碰链文件的 bugfix 次数） */
export const FIX_COUNT_THRESHOLD = 3;

/** 触发占比阈值（0-1） */
export const FIX_RATIO_THRESHOLD = 0.3;

/** 链规模分档窗口（Issue #647） */
export function windowDaysForChain(commitCount: number): number {
  if (commitCount <= 10) return 14;
  if (commitCount <= 30) return 21;
  return 30;
}

export interface DetectPostMergeFixDensityOptions {
  /** 现在时刻（测试可注入） */
  now?: Date;
  /** 高扇入阈值（默认 5） */
  highFaninThreshold?: number;
  /** bugfix 次数阈值（默认 3） */
  fixCountThreshold?: number;
  /** 占比阈值（默认 0.3） */
  fixRatioThreshold?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 带解析结果的 commit 输入（与 detect-signals 的 SignalCommitInput 同形态） */
export interface DensityCommitInput {
  sha: string;
  date: string;
  message: string;
  parsed: ParsedCommit;
  filesChanged: string[];
}

/**
 * 高扇入排除清单：被 ≥N 条特性链触碰的文件（链级归因稀释，不参与链级计数）。
 *  文件级出血由 bug_recurrence 兜底（无排除）——两级契约显式分工。 */
function buildHighFaninExclusion(chains: FeatureChain[], faninThreshold: number): Set<string> {
  const fileFanin = new Map<string, Set<string>>();
  for (const ch of chains) {
    for (const file of ch.touchFiles) {
      let owners = fileFanin.get(file);
      if (!owners) {
        owners = new Set();
        fileFanin.set(file, owners);
      }
      owners.add(ch.featureId);
    }
  }
  return new Set(
    [...fileFanin.entries()].filter(([, owners]) => owners.size >= faninThreshold).map(([f]) => f),
  );
}

/** 单链窗口统计结果（detectChainDensity 内部形态） */
interface ChainDensityStats {
  fixCount: number;
  relatedTotal: number;
  fixCommits: Array<{ sha: string; date: string; changeType: string | null; message: string }>;
}

/** 单链窗口上下文（参数打包，避免超 max-params） */
interface ChainWindow {
  windowStartMs: number;
  windowEndMs: number;
  chainFiles: Set<string>;
  excludedFiles: Set<string>;
}

/** 单链窗口统计：窗口内触碰链文件（排除后）的 bugfix 数与相关 commit 总数 */
function detectChainDensity(
  commits: DensityCommitInput[],
  ctx: ChainWindow,
): ChainDensityStats {
  let fixCount = 0;
  let relatedTotal = 0;
  const fixCommits: ChainDensityStats["fixCommits"] = [];
  for (const c of commits) {
    const t = new Date(c.date).getTime();
    // 窗口（合入后 ~ 合入+窗口天数）：严格大于合入时刻——合入 commit 自身不算「合并后修复」
    if (!(t > ctx.windowStartMs && t <= ctx.windowEndMs)) continue;
    const touched = c.filesChanged.some(f => ctx.chainFiles.has(f) && !ctx.excludedFiles.has(f));
    if (!touched) continue;
    relatedTotal++;
    if (c.parsed.changeType === "BugFix") {
      fixCount++;
      fixCommits.push({
        sha: c.sha.slice(0, 8),
        date: new Date(c.date).toISOString(),
        changeType: c.parsed.changeType,
        message: c.message,
      });
    }
  }
  return { fixCount, relatedTotal, fixCommits };
}

/**
 * 检测合并后修复密度：对每条「已合入」（= 链上有 commit）的特性链，
 * 取合入时刻（最后 main commit）后的分档窗口，统计窗口内触碰链文件的 bugfix。
 *
 * @param commits 全窗口 commit 流（时间序不敏感，内部不重排——窗口按日期过滤）
 * @param chains 特性链（ChainBuilder 输出）
 */
export function detectPostMergeFixDensity(
  commits: DensityCommitInput[],
  chains: FeatureChain[],
  options: DetectPostMergeFixDensityOptions = {},
): DetectedSignal[] {
  const now = options.now ?? new Date();
  const faninThreshold = options.highFaninThreshold ?? HIGH_FANIN_THRESHOLD;
  const countThreshold = options.fixCountThreshold ?? FIX_COUNT_THRESHOLD;
  const ratioThreshold = options.fixRatioThreshold ?? FIX_RATIO_THRESHOLD;
  const excludedFiles = buildHighFaninExclusion(chains, faninThreshold);
  const signals: DetectedSignal[] = [];
  for (const ch of chains) {
    const signal = buildChainSignal(commits, ch, {
      now,
      countThreshold,
      ratioThreshold,
      excludedFiles,
    });
    if (signal) signals.push(signal);
  }
  return signals;
}

/** 单链信号构建：窗口未过/未触发返回 null（detectPostMergeFixDensity 循环体拆出） */
function buildChainSignal(
  commits: DensityCommitInput[],
  ch: FeatureChain,
  cfg: {
    now: Date;
    countThreshold: number;
    ratioThreshold: number;
    excludedFiles: Set<string>;
  },
): DetectedSignal | null {
  const reg = SIGNAL_REGISTRY.post_merge_fix_density;
  const lastCommitAt = ch.lastCommitAt;
  // 合入时刻 = 最后 main commit（squash 流近似）。orphan/doc-only 链无 commit 时刻，跳过
  if (!lastCommitAt) return null;

  const windowDays = windowDaysForChain(ch.commitCount);
  const windowStartMs = lastCommitAt.getTime();
  const windowEndMs = lastCommitAt.getTime() + windowDays * DAY_MS;
  // 窗口已完全过去才检测（还在窗口内的链数据未定型，不报——Why: 合入当天就在报会
  // 把「边开发边修」误算成「合入后修复」，口径必须是「合入之后」的修复）
  if (cfg.now.getTime() < windowEndMs) return null;

  const stats = detectChainDensity(commits, {
    windowStartMs,
    windowEndMs,
    chainFiles: ch.touchFiles,
    excludedFiles: cfg.excludedFiles,
  });
  const fixRatio = stats.relatedTotal > 0 ? stats.fixCount / stats.relatedTotal : 0;
  const triggered = stats.fixCount >= cfg.countThreshold
    || (stats.relatedTotal > 0 && fixRatio >= cfg.ratioThreshold);
  if (!triggered) return null;

  return {
    type: reg.type,
    name: reg.name,
    severity: reg.severity,
    featureId: ch.featureId,
    filePath: null,
    evidence: `${ch.featureId} 合入后 ${windowDays} 天窗口（按链规模分档）内触碰链文件的 bugfix ${stats.fixCount} 次 / 相关 ${stats.relatedTotal} commit（占比 ${(fixRatio * 100).toFixed(0)}%${cfg.excludedFiles.size > 0 ? `，排除高扇入文件 ${cfg.excludedFiles.size} 个` : ""}）`,
    suggestedAction: reg.suggestedAction,
    detail: {
      kind: "post_merge_fix_density",
      mergedAt: lastCommitAt.toISOString(),
      windowDays,
      fixCommits: stats.fixCommits,
      totalRelatedCommits: stats.relatedTotal,
      fixRatio: Number(fixRatio.toFixed(4)),
      excludedHighFaninFiles: [...cfg.excludedFiles].sort(),
    },
  };
}
