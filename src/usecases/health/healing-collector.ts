/**
 * HealingCollector: 从 healing_events 表采集 healing 事件信息
 * 
 * 用于信号检测（behavior_defect）和指标计算。
 */

import type { HealingEvent } from "@entities/healing/healing-event";

export interface CollectedHealingEvent {
  /** 事件 ID */
  id: string;
  /** 错误类型 */
  errorType: string;
  /** 严重程度 */
  severity: string;
  /** 状态 */
  status: string;
  /** 关联的 PR（引入问题的 PR） */
  introducedByPr: string | null;
  /** 创建时间 */
  createdAt: string;
  /** 解决时间 */
  resolvedAt: string | null;
}

/**
 * 从 healing_events 表采集 healing 事件信息
 * @param healingEvents healing 事件列表（从数据库查询）
 * @returns 采集的 healing 事件列表
 */
export function collectHealingEvents(
  healingEvents: HealingEvent[]
): CollectedHealingEvent[] {
  return healingEvents.map(event => ({
    id: event.id,
    errorType: event.errorType,
    severity: event.severity,
    status: event.status,
    introducedByPr: event.introducedByPr ?? null,
    createdAt: event.createdAt,
    resolvedAt: event.resolvedAt,
  }));
}

/**
 * 按 errorType 聚合 healing 事件
 * @param events healing 事件列表
 * @returns 按 errorType 聚合的统计
 */
export function aggregateByErrorType(
  events: CollectedHealingEvent[]
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const event of events) {
    result[event.errorType] = (result[event.errorType] ?? 0) + 1;
  }
  return result;
}

/**
 * 按 introducedByPr 聚合 healing 事件
 * @param events healing 事件列表
 * @returns 按 PR 号聚合的统计
 */
export function aggregateByIntroducedByPr(
  events: CollectedHealingEvent[]
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const event of events) {
    if (event.introducedByPr) {
      result[event.introducedByPr] = (result[event.introducedByPr] ?? 0) + 1;
    }
  }
  return result;
}

/**
 * 检测 behavior_defect 信号（同一 errorType 复发）
 * @param events healing 事件列表
 * @param threshold 触发阈值（默认 3）
 * @returns 触发的信号列表
 */
export function detectBehaviorDefects(
  events: CollectedHealingEvent[],
  threshold: number = 3
): Array<{ errorType: string; count: number; eventIds: string[] }> {
  const byType: Record<string, string[]> = {};
  for (const event of events) {
    if (!byType[event.errorType]) {
      byType[event.errorType] = [];
    }
    byType[event.errorType].push(event.id);
  }

  return Object.entries(byType)
    .filter(([, ids]) => ids.length >= threshold)
    .map(([errorType, ids]) => ({
      errorType,
      count: ids.length,
      eventIds: ids,
    }));
}
