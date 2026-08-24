/** Healing event 错误类型 */
export type HealingErrorType =
  | 'tool_failure'
  | 'missing_context'
  | 'wrong_tool'
  | 'format_violation'
  | 'knowledge_gap'
  | 'performance'
  /** F20260818cbkr：degenerate guard 触发（每次退化均落一条） */
  | 'degenerate'
  /** F20260818cbkr：熔断重启执行（context.newSessionId 关联新 session） */
  | 'circuit_break'
  /** F20260824srst：自重启执行（context.newSessionId 关联新 session，防循环上限判定） */
  | 'self_restart'
  | 'other';

/** Healing event 严重程度 */
export type HealingSeverity = 'low' | 'medium' | 'high';

/** Healing event 状态 */
export type HealingEventStatus = 'open' | 'analyzing' | 'resolved' | 'dismissed';

/** 修复行动类型 */
export type HealingResolutionAction =
  | 'prompt_updated'
  | 'memory_added'
  | 'tool_fixed'
  | 'config_changed'
  | 'no_action'
  | 'deferred';

/** 修复决策记录 */
export interface HealingResolution {
  action: HealingResolutionAction;
  decidedBy: 'user' | 'agent';
  decidedAt: string;
  notes: string;
}

/** Healing event 实体 */
export interface HealingEvent {
  id: string;
  messageId: string;
  conversationId: string;
  otterId: string;
  errorType: HealingErrorType;
  severity: HealingSeverity;
  description: string;
  suggestion: string;
  context: Record<string, unknown> | null;
  status: HealingEventStatus;
  resolution: HealingResolution | null;
  /** PR ID（PR 评估体系：问题引入的 PR） */
  introducedByPr?: string;
  createdAt: string;
  resolvedAt: string | null;
}

/** Healing event 统计 */
export interface HealingEventStats {
  open: number;
  resolved: number;
  dismissed: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
}
