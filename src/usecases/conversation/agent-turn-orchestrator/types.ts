/**
 * AgentTurnOrchestrator 类型定义
 *
 * Why: 将接口定义从 orchestrator.ts 中分离，减少主文件行数。
 */

import type { Logger } from "@usecases/ports/logger";
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
  senderId: string;
  retryCount: number;
  manualRetry: boolean;
  attemptStartTime: number;
}

/** 发言轮结果 */
export interface TurnResult {
  messageId: string;
  duration: number;
  tokenUsage?: { input: number; output: number };
  aggregatedTargets?: string[];
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

/** TurnCallbacks - orchestrator 回调 adapter 的接口 */
export interface TurnCallbacks {
  /** 消息生命周期回调 */
  completeMessage(messageId: string, input?: { contextTokens?: number; contextTokensMax?: number }): Promise<{ turnClose: { aggregatedTargets?: string[] } }>;
  failMessage(messageId: string, body?: string, talkingStonePassedTo?: string[]): Promise<void>;
  abortMessage(messageId: string, input: { body: string; talkingStonePassedTo?: string[] }): Promise<void>;
  /** 广播消息到 Web 和飞书 */
  broadcastMessage(messageId: string): Promise<void>;
  /** 查询消息状态 */
  getMessageById(messageId: string): Promise<{ status: string; body?: string; turnId?: string } | null>;
  /** 发送系统消息 */
  sendSystem(conversationId: string, body: string): Promise<{ id: string; body: string | null; sequenceNum: number }>;
  /** 创建新消息（重试用） */
  startNewMessage(conversationId: string, senderId: string, talkingStonePassedTo: string[]): Promise<{ id: string; sequenceNum: number; createdAt: string }>;
  /** 重试准备 */
  prepareForRetry(messageId: string): Promise<void>;
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
