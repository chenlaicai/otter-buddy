import type { HealingEvent, HealingEventStats, HealingEventStatus, HealingResolution, HealingErrorType } from '@entities/healing/healing-event';

/** Healing event 持久化仓库接口 */
export interface HealingEventRepository {
  create(event: HealingEvent): Promise<void>;
  findById(id: string): Promise<HealingEvent | null>;
  findOpen(limit?: number): Promise<HealingEvent[]>;
  findAll(status: HealingEventStatus, limit?: number): Promise<HealingEvent[]>;
  findByConversation(conversationId: string, errorType?: string): Promise<HealingEvent[]>;
  /** F20260818cbkr：按 otter 查最近指定类型事件（created_at 倒序），熔断判定数据源 */
  findRecentByOtter(otterId: string, errorType: string, limit?: number): Promise<HealingEvent[]>;
  updateStatus(id: string, status: HealingEventStatus): Promise<void>;
  resolve(id: string, resolution: HealingResolution): Promise<void>;
  getStats(): Promise<HealingEventStats>;
  /** 自动清理：dismiss 超过 N 天未更新的 open 事件 */
  autoStaleDismiss(staleDays: number): Promise<number>;

  /**
   * F20260825b424：按 filter 批量 resolve，替代逐条 ID 操作。
   * Why: 消除「query 50 条 + 手工抄 ID 漏 1 起」类缺口。
   *
   * @param filter - 过滤条件（status/errorType/createdBefore/createdAfter），全部 AND
   * @param resolution - resolve 记录
   * @param options.limit - 单批上限（默认 100）
   * @param options.dryRun - true 时只返回匹配数不执行 resolve
   */
  batchResolveByFilter(
    filter: HealingEventBatchFilter,
    resolution: HealingResolution,
    options?: { limit?: number; dryRun?: boolean },
  ): Promise<BatchResolveResult>;
}

/** 批量 resolve 过滤条件（全 AND） */
export interface HealingEventBatchFilter {
  /** 状态筛选，默认 'open' */
  status?: HealingEventStatus;
  errorType?: HealingErrorType;
  createdBefore?: string; // ISO timestamp
  createdAfter?: string;  // ISO timestamp
}

/** 批量 resolve 结果 */
export interface BatchResolveResult {
  matched: number;
  resolved: number;
  resolvedIds: string[];
  /** true 时 matched < totalMatched，调用方应再次执行以处理剩余批次 */
  truncated?: boolean;
  /** filter 全量匹配数（不含 limit），供调用方判断是否有剩余 */
  totalMatched?: number;
}
