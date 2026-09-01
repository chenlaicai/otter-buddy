/**
 * HealthScore: 健康指标评分（issue #595，原设计 R20260829hidx）
 *
 * 在可观测数据（overview/distribution 快照行 + 信号计数）之上计算语义层：
 * 五维度健康分（0-100 + 绿/黄/红）+ 加权综合分 + 拖累归因 + 走向判定。
 *
 * 全确定性规则（无 LLM 判定，与信号引擎同一哲学）；纯函数零副作用，
 * worker 旁路（rhi-scan-worker.persistSnapshot）与 score 端点共用同一实现。
 *
 * 维度口径（审视闭环后的最终版）：
 * - D1 质量成本: bugfix_ratio 分段线性 min(100, 100×max(0,(0.4-ratio)/0.2))
 * - D2 架构稳定: 100 - min(60, hotspot文件数×4) - imbalance触发?20:0（clamp）
 * - D3 交付活力: active占比×100 - regressed占比×150 - zombie占比×100（clamp）
 * - D4 流程合规: compliance_rate×100（线性）
 * - D5 信号压力: 100-(critical密度×40+warning密度×30)（clamp）；
 *   活跃链 = state∈{active,stalled}（zombie/orphan 积压由 D3 惩罚，不重复压 D5）；
 *   输入口径 #652 方案甲：confidence=low 信号（大概率误报）在源头计数时排除
 *   （rhi-scan-worker.countOpenBySeverity），本函数无需感知置信分层
 *
 * 无数据维度（如回填历史无 chain_states）：score=null（「—」），
 * 不参与综合分加权，综合分按其余维度权重归一。
 */

/** 走向：向好 / 持平 / 恶化；数据不足为 null（面板显示「—」） */
export type TrendDirection = "improving" | "stable" | "declining";

export type DimensionId = "D1" | "D2" | "D3" | "D4" | "D5";

export type HealthStatus = "green" | "yellow" | "red";

/** 综合分权重（#595 设计定稿；实测校准跟踪在 issue #595 后续项） */
export const DIMENSION_WEIGHTS: Record<DimensionId, number> = {
  D1: 0.25,
  D2: 0.2,
  D3: 0.25,
  D4: 0.1,
  D5: 0.2,
};

export const DIMENSION_NAMES: Record<DimensionId, string> = {
  D1: "质量成本",
  D2: "架构稳定",
  D3: "交付活力",
  D4: "流程合规",
  D5: "信号压力",
};

/** 走向判定阈值：近 7 天均值 vs 前 7 天均值，差值绝对值超过此值判 ↑/↓ */
export const TREND_THRESHOLD = 5;

/** 单日评分输入（全部来自既有快照行 + 信号表，零新采集） */
export interface HealthScoreInput {
  snapshotDate: string;
  /** overview：bugfix_ratio（0-1）与合规分子分母 */
  bugfixRatio: number | null;
  totalCommits: number;
  compliantCommits: number;
  /** distribution.file_hotspots 的 metadata（热区文件列表） */
  hotspotFiles: Array<{ file: string; count: number }>;
  /** distribution.change_types 的 metadata（各 changeType 计数） */
  changeTypes: Record<string, number>;
  /** distribution.chain_states 的 metadata（五态计数）；null=当日无链数据 */
  chainStates: Record<string, number> | null;
  /** 当前 open 信号计数（按 severity；#652 方案甲：confidence=low 不计入——源头过滤） */
  openSignals: { critical: number; warning: number };
}

export interface DimensionScore {
  dimension: DimensionId;
  name: string;
  /** 0-100；null=无数据（「—」） */
  score: number | null;
  status: HealthStatus | null;
  /** 拖累归因：该维度内扣分最大的因子一句话（null=无或满分） */
  attribution: string | null;
}

export interface HealthScoreResult {
  snapshotDate: string;
  dimensions: DimensionScore[];
  /** 加权综合分（无数据维度权重归一）；全维度无数据为 null */
  overall: number | null;
  overallStatus: HealthStatus | null;
  /** 拖累归因：最低维度 + 其最大扣分项（全无数据/全满分为 null） */
  attribution: string | null;
}

/** 状态分级：≥75 绿 / 50-74 黄 / <50 红 */
export function statusFromScore(score: number): HealthStatus {
  if (score >= 75) return "green";
  if (score >= 50) return "yellow";
  return "red";
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** D1 质量成本：ratio≤20% 满分，线性降至 40% 归零（审视 S1 定稿：分段线性 + clamp） */
export function scoreD1(bugfixRatio: number): number {
  return clamp(100 * Math.max(0, (0.4 - bugfixRatio) / 0.2));
}

/** D2 架构稳定：热区文件数线性扣分（每个扣 4，总扣封顶 60）+ bugfix:feature 失衡（≥2 倍）再扣 20 */
export function scoreD2(hotspotCount: number, imbalanceTriggered: boolean): number {
  // Why: 线性 ×10 导致 10 热区即归零，20 热区与 100 热区无区分度
  // 纯线性×4 + 封顶60（与 issue #630 原方案分段递减的偏差：数值终点一致，20 热区落点 40 分仍在目标区间）
  const penalty = Math.min(60, hotspotCount * 4);
  return clamp(100 - penalty - (imbalanceTriggered ? 20 : 0));
}

/** D3 交付活力：active 占比给分，regressed（×1.5）/zombie（×1.0）占比扣分 */
export function scoreD3(chainStates: Record<string, number>): number {
  const total = Object.values(chainStates).reduce((s, n) => s + n, 0);
  if (total <= 0) return 0;
  const pct = (k: string) => (chainStates[k] ?? 0) / total;
  return clamp(pct("active") * 100 - pct("regressed") * 150 - pct("zombie") * 100);
}

/** D5 信号压力：open 信号按活跃链（active+stalled）归一后的密度扣分 */
export function scoreD5(critical: number, warning: number, activeChains: number): number {
  if (activeChains <= 0) return 0;
  const cd = critical / activeChains;
  const wd = warning / activeChains;
  return clamp(100 - (cd * 40 + wd * 30));
}

/** bugfix:feature ≥2 判失衡（与信号引擎 hotspot_imbalance 同口径） */
function isImbalanceTriggered(changeTypes: Record<string, number>): boolean {
  const bugfix = changeTypes["BugFix"] ?? 0;
  const feature = (changeTypes["New Feature"] ?? 0) + (changeTypes["Feature Update"] ?? 0);
  return feature > 0 && bugfix / feature >= 2;
}

function dimensionD1(input: HealthScoreInput): DimensionScore {
  if (input.bugfixRatio === null || input.totalCommits <= 0) {
    return { dimension: "D1", name: DIMENSION_NAMES.D1, score: null, status: null, attribution: null };
  }
  const score = scoreD1(input.bugfixRatio);
  return {
    dimension: "D1",
    name: DIMENSION_NAMES.D1,
    score,
    status: statusFromScore(score),
    attribution: score < 100 ? `bugfix 占比 ${(input.bugfixRatio * 100).toFixed(1)}%（${input.totalCommits} 提交中修 bug 占比偏高）` : null,
  };
}

function dimensionD2(input: HealthScoreInput): DimensionScore {
  const hotspotCount = input.hotspotFiles.length;
  const imbalance = isImbalanceTriggered(input.changeTypes);
  const score = scoreD2(hotspotCount, imbalance);
  const parts: string[] = [];
  if (hotspotCount > 0) {
    const top = input.hotspotFiles[0]!;
    parts.push(`${top.file} 等 ${hotspotCount} 个热区文件（${top.count} 次修改居首）`);
  }
  if (imbalance) parts.push("bugfix:feature ≥2 失衡");
  return {
    dimension: "D2",
    name: DIMENSION_NAMES.D2,
    score,
    status: statusFromScore(score),
    attribution: parts.length > 0 ? parts.join("；") : null,
  };
}

function dimensionD3(input: HealthScoreInput): DimensionScore {
  const chainStates = input.chainStates;
  const total = chainStates ? Object.values(chainStates).reduce((s, n) => s + n, 0) : 0;
  if (!chainStates || total <= 0) {
    return { dimension: "D3", name: DIMENSION_NAMES.D3, score: null, status: null, attribution: null };
  }
  const score = scoreD3(chainStates);
  const WORST_ORDER = ["zombie", "regressed", "orphan", "stalled"] as const;
  const worstState = WORST_ORDER.find((s) => (chainStates[s] ?? 0) > 0);
  const worst = worstState ? `${worstState} 链 ${chainStates[worstState] ?? 0} 条` : null;
  return {
    dimension: "D3",
    name: DIMENSION_NAMES.D3,
    score,
    status: statusFromScore(score),
    attribution: score < 100 ? worst : null,
  };
}

function dimensionD4(input: HealthScoreInput): DimensionScore {
  if (input.totalCommits <= 0) {
    return { dimension: "D4", name: DIMENSION_NAMES.D4, score: null, status: null, attribution: null };
  }
  const rate = input.compliantCommits / input.totalCommits;
  const score = clamp(rate * 100);
  return {
    dimension: "D4",
    name: DIMENSION_NAMES.D4,
    score,
    status: statusFromScore(score),
    attribution: score < 100 ? `${input.totalCommits - input.compliantCommits} 个提交未走规范格式` : null,
  };
}

function dimensionD5(input: HealthScoreInput): DimensionScore {
  const activeChains = input.chainStates
    ? (input.chainStates["active"] ?? 0) + (input.chainStates["stalled"] ?? 0)
    : 0;
  if (activeChains <= 0) {
    return { dimension: "D5", name: DIMENSION_NAMES.D5, score: null, status: null, attribution: null };
  }
  const score = scoreD5(input.openSignals.critical, input.openSignals.warning, activeChains);
  const parts: string[] = [];
  if (input.openSignals.critical > 0) parts.push(`critical 信号 ${input.openSignals.critical} 条未处置`);
  if (input.openSignals.warning > 0) parts.push(`warning 信号 ${input.openSignals.warning} 条未处置`);
  return {
    dimension: "D5",
    name: DIMENSION_NAMES.D5,
    score,
    status: statusFromScore(score),
    attribution: parts.length > 0 ? parts.join("；") : null,
  };
}

/** 五维度评分主入口：纯函数，无数据维度 score=null */
export function computeHealthScore(input: HealthScoreInput): HealthScoreResult {
  const dimensions = [
    dimensionD1(input),
    dimensionD2(input),
    dimensionD3(input),
    dimensionD4(input),
    dimensionD5(input),
  ];

  // 综合分：无数据维度剔除后按剩余权重归一
  const scored = dimensions.filter((d): d is DimensionScore & { score: number } => d.score !== null);
  let overall: number | null = null;
  if (scored.length > 0) {
    const weightSum = scored.reduce((s, d) => s + DIMENSION_WEIGHTS[d.dimension], 0);
    overall = Number((scored.reduce((s, d) => s + d.score! * DIMENSION_WEIGHTS[d.dimension], 0) / weightSum).toFixed(1));
  }

  // 拖累归因：最低维度 + 其扣分因子
  let attribution: string | null = null;
  if (scored.length > 0) {
    const worst = scored.reduce((a, b) => (a.score! <= b.score! ? a : b));
    if (worst.score! < 100 && worst.attribution) {
      attribution = `${worst.name} ${worst.score} 分：${worst.attribution}是主要拖累`;
    }
  }

  return {
    snapshotDate: input.snapshotDate,
    dimensions,
    overall,
    overallStatus: overall !== null ? statusFromScore(overall) : null,
    attribution,
  };
}

/**
 * 走向判定：近 7 天均值 vs 前 7 天均值，差值 >±TREND_THRESHOLD 判 ↑/↓。
 * 序列按时间升序；不足 8 个数据点（前 7 天 + 至少 1 天）为 null。
 */
export function judgeTrend(series: Array<number | null>): TrendDirection | null {
  const vals = series.filter((v): v is number => v !== null);
  if (vals.length < 8) return null;
  const recent = vals.slice(-7);
  const prior = vals.slice(-14, -7);
  if (prior.length < 7) return null;
  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const delta = avg(recent) - avg(prior);
  if (delta > TREND_THRESHOLD) return "improving";
  if (delta < -TREND_THRESHOLD) return "declining";
  return "stable";
}

/** health_index 快照行（metricType=health_index）：每维度一行（无数据维度跳过）+ 综合一行 */
export function buildHealthIndexRows(result: HealthScoreResult): Array<{
  snapshotDate: string;
  metricType: string;
  metricKey: string;
  metricValue: number;
  metadata?: string;
}> {
  const rows: Array<{ snapshotDate: string; metricType: string; metricKey: string; metricValue: number; metadata?: string }> = [];
  for (const d of result.dimensions) {
    if (d.score === null) continue;
    rows.push({
      snapshotDate: result.snapshotDate,
      metricType: "health_index",
      metricKey: d.dimension,
      metricValue: d.score,
    });
  }
  if (result.overall !== null) {
    rows.push({
      snapshotDate: result.snapshotDate,
      metricType: "health_index",
      metricKey: "overall",
      metricValue: result.overall,
      metadata: JSON.stringify({ attribution: result.attribution, overallStatus: result.overallStatus }),
    });
  }
  return rows;
}
