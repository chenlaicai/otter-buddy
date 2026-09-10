/**
 * AgentTurnOrchestrator 类型定义
 *
 * F20260910ctlv 彻底切换：turn 生命周期从 messages 行剥离到 invokes 行。
 * - TurnInput.invokeId 必填（invoke 是行动主体，messageId 退役）
 * - TurnCallbacks 全部 invoke 化（completeMessage/failMessage/... 已删除）
 */

import type { Logger } from "@usecases/ports/logger";
import type { AgentMetricsPort } from "@usecases/ports/agent-metrics-port";
import type { AgentStreamEvent } from "@usecases/ports/sdk-invoke-port";
import type { AbortUnderlyingError } from "./exit-classifier";

/** 携带工具调用计数的 Error（abort 路径跨层传递用） */
export type ErrorWithToolCallCount = Error & {
  _toolCallCount?: number;
  _outputGuardMetadata?: { firstByteLatencyMs?: number };
  _modelAlias?: string;
};

/** invoke 结果形状 */
export interface InvokeResultShape {
  text: string;
  tokenUsage?: { input: number; output: number };
  ctxTokens?: number;
  ctxMax?: number;
  modelAlias?: string;
  sessionRebuilt?: boolean;
  outputGuardMetadata?: { totalLength: number; tripped: boolean; reason?: string; firstByteLatencyMs?: number };
  /** LLM 直出文本（未通过 speak 输出，对其他人不可见）。用于检测"旁白流失"失败形态 */
  directText?: string;
}

/** Attempt 执行结果 */
export interface AttemptResult {
  result: InvokeResultShape;
  toolCallCount: number;
}

/** 发言轮输入（F20260910ctlv：invokeId 必填——invoke 是行动主体） */
export interface TurnInput {
  otterId: string;
  conversationId: string;
  /** F20260910ctlv：invoke ID（状态机主体。yield 工具置 completed = 成功信号） */
  invokeId: string;
  userMessageContent: string;
  /** F20260818cbkr：用户原始消息。retry 会覆写 userMessageContent 为系统提醒文案，熔断摘要必须取此字段 */
  originalUserMessage: string;
  senderId: string;
  retryCount: number;
  manualRetry: boolean;
  attemptStartTime: number;
}

/**
 * F20260818cbkr 熔断信号载荷。挂在 TurnResult 上跨层上抛——
 * executeTurn 不在循环内消费（区别于重试），
 * 由 agent-invoker 检测后执行 restartSession + 全新 invoke。
 */
export interface CircuitBreakInfo {
  otterId: string;
  conversationId: string;
  originalUserMessage: string;
  failedInvokeId: string;
  toolCallCount: number;
}

/** 发言轮结果（F20260910ctlv：invokeId 主体，messageId 退役） */
export interface TurnResult {
  invokeId: string;
  duration: number;
  tokenUsage?: { input: number; output: number };
  /** F20260818cbkr：degenerate 二次退化时携带，agent-invoker 执行熔断重启 */
  _circuitBreak?: CircuitBreakInfo;
}

/** AttemptDriver - orchestrator 驱动 adapter 的执行面（仅限重执行当前轮） */
export interface AttemptDriver {
  /** 执行一次 agent invoke，返回结果 + toolCallCount */
  invoke(input: TurnInput, onEvent: (event: AgentStreamEvent) => void): Promise<AttemptResult>;
  /** 中止 agent 生成 */
  abort(otterId: string, invokeId?: string): void;
  /** 获取内部 abort 原因（outputGuard 等） */
  getInternalAbortReason(invokeId: string): string | undefined;
  /** 获取工具调用计数 */
  getToolCallCount(otterId: string, invokeId: string): number;
  /** 检查 invoke 是否被用户中止 */
  isUserAborted(invokeId: string): boolean;
}

/** F20260818cbkr：healing 事件写入回调入参（完整实体由 invoker 层组装） */
export interface HealingEventInput {
  invokeId: string;
  conversationId: string;
  otterId: string;
  errorType: "degenerate" | "circuit_break" | "self_restart" | "guard_intercept" | "rate_limit";
  severity: "low" | "medium" | "high";
  description: string;
  suggestion?: string;
  context?: Record<string, unknown>;
}

/** TurnCallbacks - orchestrator 回调 adapter 的接口（F20260910ctlv：全部 invoke 化） */
export interface TurnCallbacks {
  /** 查询 invoke 状态（成功检测判据：status 离开 running = 已 yield） */
  getInvokeById(invokeId: string): Promise<{ status: string; toolCallCount: number; talkingStonePassedTo?: string[] | null } | null>;
  /** 更新 invoke 状态（终态化） */
  updateInvokeStatus(invokeId: string, status: 'completed' | 'failed' | 'aborted'): Promise<void>;
  /** 更新 invoke 发言石去向（abort/no_yield 耗尽时回传触发者） */
  updateInvokeTalkingStonePassedTo?(invokeId: string, targets: string[]): Promise<void>;
  /** 更新 invoke token 用量（成功路径终态快照） */
  updateInvokeTokenUsage?(invokeId: string, input: number, output: number): Promise<void>;
  /** 创建 invoke_end entry（fail/abort 终态条目） */
  createInvokeEndEntry(invokeId: string, status: 'failed' | 'aborted', body?: string): Promise<void>;
  /** 发送 invoke.end SSE 事件 */
  emitInvokeEnd(invokeId: string, status: 'completed' | 'failed' | 'aborted', duration: number, stats?: { toolCallCount?: number; tokenUsage?: { input: number; output: number } }): void;
  /** F20260818cbkr：写 healing 事件（degenerate guard 触发点数据源） */
  recordHealingEvent(input: HealingEventInput): Promise<void>;
  /**
   * #731：查询 otter 在滑窗内的 guard bounce 次数（errorType=guard_intercept 且 context.bounced=true，
   * 含调用时刻刚落账的本轮）。上限判定数据源；不可用时拋错由调用方 fail-closed 升级。
   */
  getRecentGuardBounces(otterId: string, windowMs: number): Promise<number>;
  /** F20260818cbkr：当前 active session 是否由熔断创建（上限判定） */
  isSessionCircuitBreakCreated(otterId: string): Promise<boolean>;
  /** F20260818cbkr：熔断是否可用。上限/二级判定依赖 healing_events 状态载体，repo 缺失时禁用并降级为旧 abort 语义 */
  isCircuitBreakerEnabled(): boolean;
  /** 发送系统消息（F20260910ctlv：只写 entries + entry.system SSE，实现方负责） */
  sendSystem(conversationId: string, body: string): Promise<{ id: string; body: string | null; sequenceNum: number }>;
  /** 查询 otter */
  getOtterById(otterId: string): Promise<{ name: string; type?: string } | null>;
  /** 查询用户显示名 */
  getPartnerLabel(): Promise<string>;
  /** SSE 事件推送（只允许 entry.x / invoke.x / turn.complete / error 等——message.x 已退役） */
  emitEvent(event: { event: string; data: Record<string, unknown> }): void;
  /** 日志 */
  logger: Logger;
  /** metrics（可选） */
  metrics?: AgentMetricsPort;
}

/** 路由上下文（封装路由方法的共享参数） */
export interface RouteContext {
  input: TurnInput;
  result: InvokeResultShape;
  toolCallCount: number;
  driver: AttemptDriver;
  callbacks: TurnCallbacks;
  startTime: number;
  /** LLM 输出了直出文本但未调 speak（旁白流失检测） */
  hasOrphanText?: boolean;
}

/** 重试上下文 */
export interface RetryContext {
  input: TurnInput;
  failBody: string;
  retryMsg: string;
  tokenUsage?: { input: number; output: number };
  callbacks: TurnCallbacks;
  startTime: number;
}

/** 终态上下文 */
export interface TerminalContext {
  input: TurnInput;
  toolCallCount: number;
  callbacks: TurnCallbacks;
  startTime: number;
  kind: 'user' | 'guard';
  guardReason?: string;
  /** #752：用户中断时的底层 SDK 错误（用于中断归因） */
  underlyingError?: AbortUnderlyingError;
}
