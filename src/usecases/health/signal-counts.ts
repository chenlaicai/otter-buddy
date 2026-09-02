/**
 * Open 信号计数聚合（Issue #652 口径单一真相源）
 *
 * 方案甲（#652 定稿）：confidence=low 的信号不计入 critical/warning 计数与健康分，
 * 单列 byConfidence 供低置信折叠抽屉消费——「数字与视觉一致」：卡片折叠了，
 * 总分不再纹丝不动。
 *
 * COALESCE 语义：confidence 为 null/undefined/未知值的存量信号一律按 normal 处理
 * （字段缺失不丢计数——#650 之前落库的信号没有 confidence 值）。
 *
 * 消费方（两处必须同源，否则口径断层复发）：
 * - rhi-controller.overview：面板数字（openSignalsBySeverity / openSignalsByConfidence）
 * - rhi-scan-worker.countOpenBySeverity：health_index D5「信号压力」维度输入
 */

import type { SignalRecord } from "./signal-repository";

export interface OpenSignalAggregates {
  /** 按 severity 计数（仅 normal 置信——low 不进主警报数，#652 方案甲） */
  bySeverity: { critical: number; warning: number };
  /** 按置信度计数（low = 折叠抽屉数据源，数据不丢只是不进主数） */
  byConfidence: { normal: number; low: number };
}

export function aggregateOpenSignalCounts(open: SignalRecord[]): OpenSignalAggregates {
  const bySeverity = { critical: 0, warning: 0 };
  const byConfidence = { normal: 0, low: 0 };
  for (const s of open) {
    if (s.confidence === "low") {
      byConfidence.low++;
      continue;
    }
    // COALESCE 语义：null/undefined/未知值按 normal（存量信号字段缺失时不丢计数）
    byConfidence.normal++;
    if (s.severity === "critical") bySeverity.critical++;
    else bySeverity.warning++;
  }
  return { bySeverity, byConfidence };
}
