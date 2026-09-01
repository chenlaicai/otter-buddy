/**
 * SnapshotShift: 健康分环比骤变检测（Issue #645）
 *
 * 输入相邻两日的 health_index 快照行（五维 + overall，metricKey=D1..D5/overall），
 * 输出 |Δ|≥阈值的维度骤变列表。全确定性、无 LLM、纯函数。
 *
 * 消费链（Issue #645 定稿）：本模块只产出检测函数；每日检查任务用
 * findByDateRange(昨日, 今日) 取快照行后调用，深挖信号 evidence 给出的
 * 维度与前后值。数据形态为消费关系（不修改 signal-repository 的 upsert/schema）。
 *
 * null 维度语义（health-score.ts「无数据维度不参与加权」的 diff 对齐）：
 * score=null 表示当日该维度无数据（如回填历史无链数据），跳过不算 Δ，
 * 在 evidence 中注明原因，避免把「没数据」误报成「骤变」。
 */

import type { DimensionId } from "./health-score";

/** 环比骤变判定阈值：单日 |Δ|≥10 触发（五维与综合分同阈值，issue #645 定稿） */
export const SNAPSHOT_SHIFT_THRESHOLD = 10;

/** 相邻两日的健康分快照值（null=当日该维度无数据，不参与 diff） */
export interface HealthIndexSnapshot {
  snapshotDate: string;
  /** metricKey：D1..D5 或 overall */
  metricKey: string;
  metricValue: number | null;
}

/** 单维度骤变结果 */
export interface ShiftDimension {
  dimension: string;
  previous: number;
  current: number;
  /** current - previous（带符号） */
  delta: number;
}

/** 环比骤变检测结果（一个 overall 调用产出至多一条） */
export interface SnapshotShiftResult {
  /** 是否触发（任一维度 |Δ|≥threshold 或综合分 |Δ|≥threshold） */
  triggered: boolean;
  /** 骤变维度列表（含带符号 delta） */
  shifts: ShiftDimension[];
  /** 跳过的 null 维度及原因（evidence 注明用） */
  skipped: Array<{ dimension: string; reason: string }>;
}

/**
 * 相邻两日健康分环比 diff。
 * Why 全量入参而非逐维度调用：evidence 要一次说清「哪几个维度动了几分」，
 * 逐维度调用会让消费方自己拼装证据。
 */
export function diffHealthIndex(
  previous: HealthIndexSnapshot[],
  current: HealthIndexSnapshot[],
  threshold: number = SNAPSHOT_SHIFT_THRESHOLD,
): SnapshotShiftResult {
  const prevByKey = new Map(previous.map(s => [s.metricKey, s]));
  const shifts: ShiftDimension[] = [];
  const skipped: Array<{ dimension: string; reason: string }> = [];

  for (const cur of current) {
    const prev = prevByKey.get(cur.metricKey);
    if (!prev) {
      skipped.push({ dimension: cur.metricKey, reason: "前一日无此维度数据，无法环比" });
      continue;
    }
    if (cur.metricValue === null || prev.metricValue === null) {
      // null 维度语义：无数据≠骤变，跳过并注明（health-score「无数据维度不参与加权」的 diff 对齐）
      skipped.push({
        dimension: cur.metricKey,
        reason: cur.metricValue === null
          ? "当日无数据（null 维度不参与加权，不算 Δ）"
          : "前一日无数据（null 维度不参与加权，不算 Δ）",
      });
      continue;
    }
    const delta = cur.metricValue - prev.metricValue;
    if (Math.abs(delta) >= threshold) {
      shifts.push({ dimension: cur.metricKey, previous: prev.metricValue, current: cur.metricValue, delta });
    }
  }

  return { triggered: shifts.length > 0, shifts, skipped };
}

/** 维度展示名（overall 无专名的兜底） */
function dimensionName(key: string): string {
  const NAMES: Record<string, string> = {
    D1: "质量成本", D2: "架构稳定", D3: "交付活力", D4: "流程合规", D5: "信号压力",
  };
  return NAMES[key] ?? (key === "overall" ? "综合分" : key);
}

/**
 * 由 diff 结果构建 snapshot_shift 信号的 evidence 与 suggestedAction。
 * Why 独立于 diffHealthIndex：threshold 语义在两侧不同（diff 是判定口径、
 * evidence 是展示口径），耦合会让「只调阈值不复算」的用法产生漂移。
 */
export function buildSnapshotShiftEvidence(
  diff: SnapshotShiftResult,
  options: { previousDate: string; currentDate: string; threshold?: number } ,
): { evidence: string; suggestedAction: string } {
  const threshold = options.threshold ?? SNAPSHOT_SHIFT_THRESHOLD;
  const parts = diff.shifts.map(s =>
    `${dimensionName(s.dimension)} ${s.previous}→${s.current}（Δ${s.delta > 0 ? "+" : ""}${s.delta}）`,
  );
  let evidence = `${options.previousDate}→${options.currentDate} 环比骤变 ≥${threshold}：${parts.join("；")}`;
  if (diff.skipped.length > 0) {
    evidence += `；跳过：${diff.skipped.map(s => `${s.dimension}（${s.reason}）`).join("、")}`;
  }
  const dims = diff.shifts.map(s => dimensionName(s.dimension)).join("/");
  return {
    evidence,
    suggestedAction: `深挖 ${options.currentDate} 快照 diff：核对 ${dims} 上升/下降因子（对照当日 metrics 与信号变更）`,
  };
}

/** 复用 health-score 的维度 ID 窄化（防御性：metricKey 脏数据不进 dimensionName 的白名单也不炸） */
export type { DimensionId };
