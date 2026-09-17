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
  /** F20260831aksp：bash 安全守卫拦截（框架层每次拦截记 medium 样本；编排层同消息二拦终态补 high） */
  | 'guard_intercept'
  /** #543：模型限流/配额耗尽（api_error 终态识别；context 含 modelAlias/exhausted/resetHint） */
  | 'rate_limit'
  /** F20260904tflp：工具使用感受反馈（海獭主动报难用/多余/过度设计；description 以 [tool:工具名] 前缀标识） */
  | 'tool_use_feedback'
  | 'other';

/**
 * #998：errorType 二维分账——「环境/系统失败」vs「獭能力失败」。
 * 混排会让 daily-review 把工具故障误读成獭不行、把獭不行误读成工具故障，
 * 两种误判的处置方向完全相反（Qwen-UI-Agent：环境抖动单列是小团队 RL 不收敛误判的主因）。
 * 纯映射函数，不改 schema、不动存量数据。
 */
export type HealingFailureClass = 'environment' | 'capability';

const ENVIRONMENT_TYPES: ReadonlySet<HealingErrorType> = new Set([
  'tool_failure',     // 工具故障/超时/429（环境侧）
  'rate_limit',       // 模型配额耗尽（供应商侧）
  'circuit_break',    // 熔断执行（系统保护动作）
  'self_restart',     // 自重启执行（系统保护动作）
  'guard_intercept',  // 框架守卫拦截（系统侧规则触发）
]);

const CAPABILITY_TYPES: ReadonlySet<HealingErrorType> = new Set([
  'missing_context',    // 检索缺失（獭该查没查）
  'wrong_tool',         // 用错工具
  'format_violation',   // 格式异常
  'knowledge_gap',      // 知识缺口
  'performance',        // 性能/质量退化
  'degenerate',         // 输出退化（能力表现）
  'tool_use_feedback',  // 獭主动反馈（獭侧信号）
]);

/** #998：errorType → 二维分类。other 默认 capability（Unknown 归因于獭，保守不粉饰系统） */
export function classifyHealingErrorType(t: HealingErrorType): HealingFailureClass {
  if (ENVIRONMENT_TYPES.has(t)) return 'environment';
  if (CAPABILITY_TYPES.has(t)) return 'capability';
  return 'capability'; // other
}

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
