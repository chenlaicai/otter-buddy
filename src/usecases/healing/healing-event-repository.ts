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
  /** 自动清理：dismiss 超过 N 天未更新的 open 事件。
   *  F20261008hcpa（#1356 选 A）：high 升级信号（如 #844 变体重试 ≥3 次升级）永不
   *  被时间静默——排除 high 走独立通道（ageOutHighAndNotify 推 healing-alert-registry）。 */
  autoStaleDismiss(staleDays: number): Promise<number>;
  /** F20261008hcpa（#1356 选 A）：查超龄 high open 事件并置 dismissed（升级提醒通道）。
   *  返回被处置的事件供调度层推 alert-registry——high 是升级信号，
   *  即使超龄也不能无声消失（与 autoStaleDismiss 的 low/medium 静默语义分层）。 */
  ageOutHighAndNotify(staleDays: number): Promise<HealingEvent[]>;

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
  /** F20261008gfrc：按 batch filter 计数（批量闸探测 high 匹配数）——
   *  与 batchResolveByFilter 同 WHERE 语义，只 count 不更新 */
  countByFilter(filter: HealingEventBatchFilter): Promise<number>;
  /** #1271（F20261008hbbd）：按 filter 批量归口到 GitHub issue（bind≠resolve）。
   *  Why: guard_intercept 同 ruleId 事件族逐条 resolve 会撞「连续同构调用」循环守卫，
   *  且归类信息只活在 resolutionNotes 文本里无法聚合查询——照 RHI batchBindIssue
   *  （#1052 同类问题先例）把归口链结构化。
   *  语义边界：只作用于 status='open' AND bound_issue IS NULL（已归口换绑属异质操作，
   *  本期不提供批量路径）；high 不拦（归口是结构化认领非静默处置，#1361 层3 恰要求
   *  high 必须 bind_issue）；事件保持 open，修复合入后走 batch_resolve + filterBoundIssue 收尾。 */
  batchBindIssue(
    filter: HealingEventBatchFilter,
    issueNumber: number,
    options?: { note?: string; limit?: number; dryRun?: boolean; now?: Date },
  ): Promise<BatchBindResult>;
}

/** 批量 resolve 过滤条件（全 AND） */
export interface HealingEventBatchFilter {
  /** 状态筛选，默认 'open' */
  status?: HealingEventStatus;
  errorType?: HealingErrorType;
  createdBefore?: string; // ISO timestamp
  createdAfter?: string;  // ISO timestamp
  /** F20261008gfrc：severity 筛选（批量闸探测 high 匹配数用） */
  severity?: 'low' | 'medium' | 'high';
  /** #1271（F20261008hbbd）：按 context.ruleId 筛选（guard_intercept 指纹分类器
   *  落的结构化字段，F20260930gslog）——同 ruleId = 同根因事件族 */
  ruleId?: string;
  /** #1271：按归口 issue 筛选；null 语义 = 未归口（bound_issue IS NULL）——
   *  batch_bind 的作用面与修复合入后的收尾查询都用它 */
  boundIssue?: number | null;
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

/** #1271：批量归口结果（字段名与 RHI SignalBatchBindResult / BatchResolveResult 对齐） */
export interface BatchBindResult {
  matched: number;
  bound: number;
  boundIds: string[];
  truncated?: boolean;
  totalMatched?: number;
}
