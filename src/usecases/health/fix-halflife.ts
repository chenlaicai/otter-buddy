/**
 * FixHalflife: 修复半衰期派生指标（Issue #645）
 *
 * 派生指标非检测器——不产生信号，落 health_snapshots 供 sparkline/热点条消费。
 * 口径：窗口内 bugfix 日期序列 → 相邻间隔序列 → 前后半窗口均值对比。
 * 间隔缩短 = bug 越来越密 = 退化（shortening）；拉长 = 进化（lengthening）。
 *
 * 全确定性纯函数（与信号引擎同一哲学），窗口与 metrics 同源（metricsWindowDays，默认 60 天）。
 */

/** 趋势判定：后半/前半均值相对变化超过此比例才判 shortening/lengthening（避免微小波动抖动） */
const TREND_REL_THRESHOLD = 0.2;

/** trend 判定的最小间隔样本数（bugfix < MIN_BUGFIX 时样本不足，trend=insufficient） */
const MIN_BUGFIX_FOR_TREND = 4;

export type FixIntervalTrend = "shortening" | "lengthening" | "stable" | "insufficient";

export interface FixIntervalResult {
  /** 窗口内平均 bugfix 间隔天数（不足 2 个 bugfix 时为 null） */
  averageIntervalDays: number | null;
  trend: FixIntervalTrend;
  /** 前半窗口平均间隔天数（样本不足为 null；metadata 供热点条展示） */
  firstHalfAvgDays: number | null;
  /** 后半窗口平均间隔天数 */
  secondHalfAvgDays: number | null;
  /** 窗口内 bugfix commit 数 */
  bugfixCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 计算修复间隔指标。
 * @param bugfixDates 窗口内 BugFix commit 日期（任意顺序，内部排序；ISO 字符串或 Date）
 */
export function computeFixInterval(bugfixDates: Array<string | Date>): FixIntervalResult {
  const times = bugfixDates
    .map(d => (d instanceof Date ? d.getTime() : new Date(d).getTime()))
    .filter(t => Number.isFinite(t))
    .sort((a, b) => a - b);

  if (times.length < 2) {
    return {
      averageIntervalDays: null,
      trend: "insufficient",
      firstHalfAvgDays: null,
      secondHalfAvgDays: null,
      bugfixCount: times.length,
    };
  }

  // 相邻间隔（天）：gaps[i] = 第 i+1 个 bugfix 距第 i 个的天数
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    gaps.push((times[i]! - times[i - 1]!) / DAY_MS);
  }

  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const averageIntervalDays = Number((avg(gaps)).toFixed(2));

  // Why 半分而非按日历切半：间隔序列的前后半直接对应「早期节奏 vs 近期节奏」，
  // 与 commit 日期在窗口内的分布无关（60 天窗口内 10 个 bugfix 全挤在最近 5 天也能正确判 shortening）
  const half = Math.floor(gaps.length / 2);
  const firstHalf = gaps.slice(0, half);
  const secondHalf = gaps.slice(half);

  let trend: FixIntervalTrend;
  let firstHalfAvgDays: number | null = null;
  let secondHalfAvgDays: number | null = null;

  // Why MIN_BUGFIX_FOR_TREND：3 个间隔以下的半分对比统计意义弱（一半只有 1 个样本），
  // 宁可报 insufficient 也不用噪声判趋势
  if (times.length < MIN_BUGFIX_FOR_TREND || firstHalf.length === 0 || secondHalf.length === 0) {
    trend = "insufficient";
  } else {
    firstHalfAvgDays = Number(avg(firstHalf).toFixed(2));
    secondHalfAvgDays = Number(avg(secondHalf).toFixed(2));
    // Why 相对变化阈值：绝对天数阈值在小间隔（如 0.5 天 vs 0.6 天）下过灵敏，
    // 相对 20% 在两个尺度下行为一致
    if (firstHalfAvgDays === 0) {
      // 前半全零间隔（同日连环修复）：后半非零即拉长，零即无法判
      trend = secondHalfAvgDays === 0 ? "stable" : "lengthening";
    } else {
      const rel = (secondHalfAvgDays - firstHalfAvgDays) / firstHalfAvgDays;
      if (rel < -TREND_REL_THRESHOLD) trend = "shortening";
      else if (rel > TREND_REL_THRESHOLD) trend = "lengthening";
      else trend = "stable";
    }
  }

  return { averageIntervalDays, trend, firstHalfAvgDays, secondHalfAvgDays, bugfixCount: times.length };
}

/** 半衰期快照行（metricType=trend）：worker persistSnapshot 追加，与 overview 行同日写入 */
export interface TrendSnapshotRow {
  snapshotDate: string;
  metricType: "trend";
  metricKey: "bugfix_interval";
  metricValue: number;
  metadata: string;
}

/** 构建快照行。样本不足时 metricValue=0（快照序列保持连续，metadata 说明 insufficient） */
export function buildFixIntervalRow(snapshotDate: string, result: FixIntervalResult): TrendSnapshotRow {
  return {
    snapshotDate,
    metricType: "trend",
    metricKey: "bugfix_interval",
    metricValue: result.averageIntervalDays ?? 0,
    metadata: JSON.stringify({
      trend: result.trend,
      firstHalfAvgDays: result.firstHalfAvgDays,
      secondHalfAvgDays: result.secondHalfAvgDays,
      bugfixCount: result.bugfixCount,
    }),
  };
}
