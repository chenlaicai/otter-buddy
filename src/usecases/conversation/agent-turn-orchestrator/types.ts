/**
 * AgentTurnOrchestrator 类型定义
 *
 * Why: 将接口定义从 orchestrator.ts 中分离，减少主文件行数。
 */

import type { Logger } from "@usecases/ports/logger";
import type { MessageSegment } from "@entities/conversation/message";
import type { AgentMetricsPort } from "@usecases/ports/agent-metrics-port";
import type { AgentStreamEvent } from "@usecases/ports/sdk-invoke-port";

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

/** 发言轮输入 */
export interface TurnInput {
  otterId: string;
  conversationId: string;
  messageId: string;
  userMessageContent: string;
  /** F20260818cbkr：用户原始消息。retry 会覆写 userMessageContent 为系统提醒文案，熔断摘要必须取此字段 */
  originalUserMessage: string;
  /** F20260818cbkr：degenerate retry 前的首条消息 id（工作进度主要在此，熔断摘要合并取用） */
  preRetryMessageId?: string;
  senderId: string;
  retryCount: number;
  manualRetry: boolean;
  attemptStartTime: number;
}

/**
 * F20260818cbkr 熔断信号载荷。挂在 TurnResult 上跨层上抛——
 * executeTurn 不在循环内消费（区别于 RetryWithNewMessageSignal），
 * 由 agent-invoker 检测后执行 restartSession + 全新 invoke。
 */
export interface CircuitBreakInfo {
  otterId: string;
  conversationId: string;
  originalUserMessage: string;
  failedMessageId: string;
  /** retry 前首条消息 id（摘要合并工具序列用；无 retry 时等同 failedMessageId） */
  firstMessageId: string;
  toolCallCount: number;
}

/** 发言轮结果 */
export interface TurnResult {
  messageId: string;
  duration: number;
  tokenUsage?: { input: number; output: number };
  aggregatedTargets?: string[];
  /** F20260818cbkr：degenerate 二次退化时携带，agent-invoker 执行熔断重启 */
  _circuitBreak?: CircuitBreakInfo;
}

/** 重试信号（degenerate_output 创建新消息重试） */
export interface RetryWithNewMessageSignal {
  _retryWithNewMessage: true;
  newMessageId: string;
  retryMsg: string;
  toolCallCount: number;
}

/** AttemptDriver - orchestrator 驱动 adapter 的执行面（仅限重执行当前轮） */
export interface AttemptDriver {
  /** 执行一次 agent invoke，返回结果 + toolCallCount */
  invoke(input: TurnInput, onEvent: (event: AgentStreamEvent) => void): Promise<AttemptResult>;
  /** 中止 agent 生成 */
  abort(otterId: string, messageId?: string): void;
  /** 获取内部 abort 原因（outputGuard 等） */
  getInternalAbortReason(messageId: string): string | undefined;
  /** 获取工具调用计数 */
  getToolCallCount(otterId: string, messageId: string): number;
  /** 检查消息是否被用户中止 */
  isUserAborted(messageId: string): boolean;
}

/** F20260818cbkr：healing 事件写入回调入参（完整实体由 invoker 层组装） */
export interface HealingEventInput {
  messageId: string;
  conversationId: string;
  otterId: string;
  errorType: "degenerate" | "circuit_break";
  severity: "low" | "medium" | "high";
  description: string;
  suggestion?: string;
  context?: Record<string, unknown>;
}

/** TurnCallbacks - orchestrator 回调 adapter 的接口 */
export interface TurnCallbacks {
  /** 消息生命周期回调 */
  completeMessage(messageId: string, input?: { contextTokens?: number; contextTokensMax?: number }): Promise<{ turnClose: { aggregatedTargets?: string[] } }>;
  failMessage(messageId: string, body?: string, talkingStonePassedTo?: string[]): Promise<void>;
  abortMessage(messageId: string, input: { body: string; talkingStonePassedTo?: string[] }): Promise<void>;
  /** F20260818cbkr：写 healing 事件（degenerate guard 触发点数据源） */
  recordHealingEvent(input: HealingEventInput): Promise<void>;
  /** F20260818cbkr：当前 active session 是否由熔断创建（上限判定） */
  isSessionCircuitBreakCreated(otterId: string): Promise<boolean>;
  /** F20260818cbkr：熔断是否可用。上限/二级判定依赖 healing_events 状态载体，repo 缺失时禁用并降级为旧 abort 语义 */
  isCircuitBreakerEnabled(): boolean;
  /** 广播消息到 Web 和飞书 */
  broadcastMessage(messageId: string): Promise<void>;
  /** 查询消息状态。segments 是消息内容的唯一载体（messages.body 列已移除，SSE body 由 aggregateBody 计算） */
  getMessageById(messageId: string): Promise<{ status: string; segments: MessageSegment[]; turnId?: string } | null>;
  /** 发送系统消息 */
  sendSystem(conversationId: string, body: string): Promise<{ id: string; body: string | null; sequenceNum: number }>;
  /** 创建新消息（重试用） */
  startNewMessage(conversationId: string, senderId: string, talkingStonePassedTo: string[]): Promise<{ id: string; sequenceNum: number; createdAt: string }>;
  /** 重试准备 */
  // F20260821fix: no_yield 重试时保留 segments（speak 内容有效，不应被删除）
  prepareForRetry(messageId: string, preserveSegments?: boolean): Promise<void>;
  /** 查询 otter */
  getOtterById(otterId: string): Promise<{ name: string; type?: string } | null>;
  /** 查询用户显示名 */
  getPartnerLabel(): Promise<string>;
  /** SSE 事件推送 */
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
}
