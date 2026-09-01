/**
 * BugfixMetrics: 修复半衰期派生指标（Issue #645）
 *
 * bugfix 间隔在缩短还是拉长：滚动窗口内相邻 bugfix commit 间隔的中位数，
 * 落 health_snapshots（metric_type=fix_interval）供 sparkline/热点条（#647）消费。
 * 缩短=退化加速（修复节奏变密），拉长=进化（问题收敛）。
 *
 * Why 派生指标而非检测器（合议定稿 §1.3）：不产生信号，只落库供时间序列回放；
 * 挂在 MetricsCalculator 输出之后（persistSnapshot 内），不另起采集管道。
 *
 * 口径实查（2026-09-01，main 60 天）：42 个 bugfix、8 个活跃日、爆发式提交模式，
 * 间隔分布右偏严重（中位 0.06d vs 均值 0.18d vs max 1.53d）→ 选**中位数**：
 * 均值会被爆发日内的分钟级间隔拉低，掩盖「平静期拉长」的真实趋势。
 */

import type { ParsedCommit } from "./commit-parser";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 修复半衰期快照行元数据（回放与口径审计用） */
export interface FixIntervalMetadata {
  /** 滚动窗口天数（快照口径的一部分，时间序列回放必读） */
  windowDays: number;
  /** 窗口内 bugfix commit 数 */
  bugfixCount: number;
  /** 参与计算的间隔数（= bugfixCount - 1；<1 时 interval 为 null） */
  intervalCount: number;
  /** 中位数口径标注 */
  stat: "median";
}

/** 修复半衰期计算结果 */
export interface FixIntervalResult {
  /** 相邻 bugfix 间隔的中位数（天）；窗口内 bugfix < 2 时为 null（无间隔可算，落 0 值行会伪造趋势） */
  intervalDays: number | null;
  metadata: FixIntervalMetadata;
}

/**
 * 计算滚动窗口内 bugfix 间隔中位数（纯函数）。
 * @param parsed 解析结果（与 dates 按 index 对齐；内部按时间升序重排，入参顺序不敏感）
 * @param dates commit 时间（ISO 字符串或 Date，与 parsed 一一对应）
 * @param now 现在时刻（测试可注入；窗口右端点）
 * @param windowDays 滚动窗口天数（默认 30）
 */
export function computeFixInterval(
  parsed: ParsedCommit[],
  dates: Array<string | Date>,
  now: Date,
  windowDays = 30,
): FixIntervalResult {
  const windowStart = now.getTime() - windowDays * DAY_MS;
  const times: number[] = [];
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i]!.changeType !== "BugFix") continue;
    const t = new Date(dates[i]!).getTime();
    if (!Number.isFinite(t) || t < windowStart || t > now.getTime()) continue;
    times.push(t);
  }
  times.sort((a, b) => a - b);

  if (times.length < 2) {
    return {
      intervalDays: null,
      metadata: { windowDays, bugfixCount: times.length, intervalCount: 0, stat: "median" },
    };
  }

  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    gaps.push((times[i]! - times[i - 1]!) / DAY_MS);
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  // 偶数个间隔取中间两数均值（标准中位数口径）；奇数取正中
  const median = gaps.length % 2 === 1
    ? gaps[mid]!
    : (gaps[mid - 1]! + gaps[mid]!) / 2;

  return {
    intervalDays: median,
    metadata: { windowDays, bugfixCount: times.length, intervalCount: gaps.length, stat: "median" },
  };
}

/**
 * 构建 fix_interval 快照行（metricType=fix_interval，挂 snapshotSink 落库）。
 * intervalDays=null 时仍落行（metricValue=0 + metadata.intervalCount=0）：
 * 消费方可区分「算不出」（无间隔）与「间隔为 0」（同刻爆发），时间序列不断点。
 */
export function buildFixIntervalRow(
  snapshotDate: string,
  result: FixIntervalResult,
): { snapshotDate: string; metricType: string; metricKey: string; metricValue: number; metadata: string } {
  return {
    snapshotDate,
    metricType: "fix_interval",
    metricKey: "bugfix_median_interval_days",
    metricValue: result.intervalDays ?? 0,
    metadata: JSON.stringify(result.metadata),
  };
}
