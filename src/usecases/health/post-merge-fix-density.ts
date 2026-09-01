/**
 * post_merge_fix_density: 合并后修复密度检测（Issue #647 项 6，PR2 的灵魂信号）
 *
 * 规则（合议定稿）：特性合入后窗口期内（小修 14 天 / 大特性 30 天），触碰链文件的
 * bugfix ≥3 次 或 占链窗口内全部 commit 的 ≥30% → 报「特性不对劲」（warning——
 * 是待查证不是定罪，不预设立场，只统计出血）。
 *
 * 三条边界（缺一不可，issue #647）：
 * 1. 高扇入文件排除清单：被 ≥FAN_IN_THRESHOLD 个特性触碰的文件自动进清单（实测
 *    src/app.ts 被 22 个特性碰过）——枢纽文件天天被碰，链级密度对它全是噪音。
 *    清单随信号 evidence 透出 + chains 端点常驻暴露（computeFanInExclusions），
 *    面板可见不黑箱。
 * 2. 占比分母 = 链窗口内全部 commit（含无 FID 的 bugfix commit），
 *    分子 = 触碰链文件的 bugfix（commit 粒度：同 commit 触碰多链文件计 1 次）。
 * 3. 显式契约：本检测器抓「哪个特性不对劲」（排除清单后），文件级 bug_recurrence
 *    抓「哪里在出血」（无排除，见 detect-signals.ts）——核心文件恰是震中时由
 *    文件级兜底，两者分工互补、互不替代。
 *
 * 分档依据（2026-09-01 实测 137 条链，squash 流）：链 commit 数 p50=p75=p90=1、
 * max=3——按 commit 数分档无区分度；链触碰文件数有真梯度（p50=2 / p75=6 /
 * max=41）。故大特性档按「链触碰文件数 > LARGE_CHAIN_FILES」划定。
 *
 * 合入时刻 = FID 最后一条 main commit（squash 流近似，合议定稿）——squash 后
 * main 上一个特性只留 1 条 commit，「最后 commit 时刻」即合入时刻。
 */

import type { SignalCommitInput, DetectedSignal } from "./detect-signals";
import type { FeatureChain } from "./chain-builder";
import { SIGNAL_REGISTRY } from "./signal-registry";

/** 分档阈值：链触碰文件数 > 此值 = 大特性档（30 天窗口），否则小修档（14 天）。
 *  实测 p75=6：多数特性 ≤6 文件；>6 是真「大特性」。 */
export const LARGE_CHAIN_FILES = 6;

/** 小修档窗口（天） */
export const SMALL_FIX_WINDOW_DAYS = 14;
/** 大特性档窗口（天） */
export const LARGE_FEATURE_WINDOW_DAYS = 30;

/** 触发阈值：窗口内触碰链文件的 bugfix ≥ 此次数 */
export const FIX_COUNT_THRESHOLD = 3;
/** 触发阈值：bugfix 占窗口全部 commit 比例 ≥ 此值 */
export const FIX_RATIO_THRESHOLD = 0.3;
/** 占比判定的最小分母：窗口内全部 commit 低于此值时占比支不启用。
 *  Why：分母 <5 时占比失真（合入后仅 1 条 bugfix → 100% 触发是荒谬的）；
 *  小样本场景由次数阈值（≥3）单支把关。 */
export const RATIO_MIN_DENOMINATOR = 5;

/** 排除清单阈值：文件被 ≥ 此数个不同特性触碰即高扇入枢纽，进排除清单。
 *  实测（2026-09-01，30/60 天窗口分布一致）：app.ts×22 / platforms.ts×18 /
 *  router.ts×11 / client.ts×11…；≥10 恰好 12 个文件（总 615），全是基础设施枢纽
 *  ——日常 bugfix 碰它们是常态，不是某个特性的余震。 */
export const FAN_IN_THRESHOLD = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 检测输入：全量 commit 流（含无 FID 的 bugfix——分母的一部分）+ 合入候选链 */
export interface PostMergeFixDensityInput {
  commits: SignalCommitInput[];
  chains: FeatureChain[];
  now: Date;
}

/** 检测产出：信号 + 排除清单（evidence 透出用，面板可见） */
export interface PostMergeFixDensityResult {
  signals: DetectedSignal[];
  /** 高扇入排除清单（file → 触碰特性数），验收项：清单可见 */
  excludedFiles: Array<{ file: string; fanIn: number }>;
}

export function detectPostMergeFixDensity(input: PostMergeFixDensityInput): PostMergeFixDensityResult {
  const { commits, chains, now } = input;
  const reg = SIGNAL_REGISTRY.post_merge_fix_density;
  const excludedFiles = collectFanInExclusions(commits);
  const excludedSet = new Set(excludedFiles.map(x => x.file));
  const excludedNote = excludedFiles.length > 0
    ? `；已排除高扇入文件 ${excludedFiles.length} 个（≥${FAN_IN_THRESHOLD} 特性触碰：${summarizeExclusions(excludedFiles)}）`
    : "";

  const signals: DetectedSignal[] = [];
  for (const chain of chains) {
    const sig = detectChainFixDensity({ chain, commits, now, reg, excludedSet, excludedNote });
    if (sig) signals.push(sig);
  }
  return { signals, excludedFiles };
}

/** 单链检测：窗口分档 → 分子分母统计 → 双阈值判定 */
function detectChainFixDensity(ctx: {
  chain: FeatureChain;
  commits: SignalCommitInput[];
  now: Date;
  reg: { type: "post_merge_fix_density"; name: string; severity: "warning"; suggestedAction: string };
  excludedSet: Set<string>;
  excludedNote: string;
}): DetectedSignal | null {
  const { chain, commits, now, reg, excludedSet, excludedNote } = ctx;
  // 合入时刻 = 链最后 commit（squash 流近似）。无 commit 的 doc-only 链无合入语义，跳过。
  const lastCommitAt = chain.lastCommitAt;
  if (!lastCommitAt) return null;
  const isLarge = chain.touchFiles.size > LARGE_CHAIN_FILES;
  const windowDays = isLarge ? LARGE_FEATURE_WINDOW_DAYS : SMALL_FIX_WINDOW_DAYS;
  const windowStart = new Date(now.getTime() - windowDays * DAY_MS);
  // 合入必须落在窗口内——合入早于窗口开启的特性不属「合并后」范畴
  // （老特性近期被 bugfix 碰是热点/复发问题，由文件级 bug_recurrence 兜底，不是合入余震）
  if (lastCommitAt < windowStart) return null;

  // 窗口内全部 commit（分母）：含无 FID 的
  const inWindow = commits.filter(c => new Date(c.date) >= windowStart);
  if (inWindow.length === 0) return null;

  // 分子：窗口内触碰链文件（排除清单后）的 bugfix，commit 粒度计 1 次
  const chainFiles = new Set([...chain.touchFiles].filter(f => !excludedSet.has(f)));
  let bugfixHits = 0;
  for (const c of inWindow) {
    if (c.parsed.changeType !== "BugFix") continue;
    if (c.filesChanged.some(f => chainFiles.has(f))) bugfixHits++;
  }

  // 占比支最小分母保护：分母 <RATIO_MIN_DENOMINATOR 时占比失真（合入后仅 1 条 bugfix
  // → 100% 触发是荒谬的），小样本场景由次数阈值单支把关
  const ratio = inWindow.length >= RATIO_MIN_DENOMINATOR ? bugfixHits / inWindow.length : 0;
  if (bugfixHits < FIX_COUNT_THRESHOLD && ratio < FIX_RATIO_THRESHOLD) return null;

  return {
    type: reg.type,
    name: reg.name,
    severity: reg.severity,
    featureId: chain.featureId,
    filePath: null,
    evidence: `${chain.featureId} 合入后 ${windowDays} 天窗口内触碰链文件的 bugfix ${bugfixHits} 次` +
      `（占窗口全部 commit ${bugfixHits}/${inWindow.length} = ${Math.round(ratio * 100)}%；` +
      `链规模 ${chain.touchFiles.size} 文件 → ${isLarge ? "大特性" : "小修"}档）${excludedNote}`,
    suggestedAction: reg.suggestedAction,
  };
}

/** 窗口内 commit 流 → 高扇入排除清单（被 ≥FAN_IN_THRESHOLD 个特性触碰的文件，降序） */
function collectFanInExclusions(commits: SignalCommitInput[]): Array<{ file: string; fanIn: number }> {
  const fanIn = new Map<string, Set<string>>();
  for (const c of commits) {
    if (!c.parsed.featureId) continue;
    for (const f of c.filesChanged) {
      if (!fanIn.has(f)) fanIn.set(f, new Set());
      fanIn.get(f)!.add(c.parsed.featureId);
    }
  }
  return rankExclusions(fanIn);
}

/** 扇入 Map → 排除清单（降序） */
function rankExclusions(fanIn: Map<string, Set<string>>): Array<{ file: string; fanIn: number }> {
  return [...fanIn.entries()]
    .filter(([, fids]) => fids.size >= FAN_IN_THRESHOLD)
    .map(([file, fids]) => ({ file, fanIn: fids.size }))
    .sort((a, b) => b.fanIn - a.fanIn);
}

/** 排除清单摘要（evidence 内嵌用：前 3 个 + 等N个） */
function summarizeExclusions(excluded: Array<{ file: string; fanIn: number }>): string {
  const head = excluded.slice(0, 3).map(x => `${x.file}×${x.fanIn}`).join("、");
  return excluded.length > 3 ? `${head} 等 ${excluded.length} 个` : head;
}

/**
 * 从链集合计算高扇入排除清单（GET /api/health/chains 响应附带——排除清单常驻可见，
 * 不依赖信号触发。验收项：清单可见不黑箱）。
 *
 * Why 从 chains 而非 commit 流：chains 端点已持有 buildChainsOnce 产物，零额外采集；
 * 链的 touchFiles 只含带 FID 的 commit 触碰的文件，与检测器扇入口径同源
 * （检测器窗口 30 天、链构建窗口 60 天——枢纽文件两窗口下分布一致，实测偏差 0）。
 */
export function computeFanInExclusions(
  chains: Array<Pick<FeatureChain, "featureId" | "touchFiles">>,
): Array<{ file: string; fanIn: number }> {
  const fanIn = new Map<string, Set<string>>();
  for (const chain of chains) {
    for (const f of chain.touchFiles) {
      if (!fanIn.has(f)) fanIn.set(f, new Set());
      fanIn.get(f)!.add(chain.featureId);
    }
  }
  return rankExclusions(fanIn);
}
