/**
 * Agent 调用端口：描述"驱动 Agent 生成"的能力。
 * PiSessionFactory (frameworks 层) 的 invoke() 方法结构匹配此接口。
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Agent 流式事件。
 *
 * 保持弱类型 + 索引签名（兼容现有消费方 + 测试 mock）。需要 discriminated union 精确 narrowing
 * 时用 re-export 的 `AgentSessionEvent`（SDK 联合类型，要求 AgentMessage 完整字段，适合生产路径）。
 *
 * R20260810piab 遗漏 1：移除了死字段 `delta`——message_update 被 createEventHandler 过滤，
 * onEvent 永远收不到；delta 实际在 assistantMessageEvent 内层（output-guard.ts 直连 subscribe 提取）。
 */
export interface AgentStreamEvent {
  type: string;
  [key: string]: unknown;
}

/** Re-export SDK 精确类型，供需要 discriminated union narrowing 的消费方使用 */
export type { AgentSessionEvent };

/** Agent 执行结果（与 Pi 的 AgentRunResult 结构匹配） */
export interface AgentRunResult {
  text: string;
  /** session 累计 token 消耗（成本口径，仅日志用；不代表上下文窗口占用） */
  tokenUsage?: { input: number; output: number };
  /** 上下文窗口占用：末次 LLM 调用的 input+output+cacheRead+cacheWrite（F20260808ctxw） */
  ctxTokens?: number;
  ctxMax?: number;
  circuitBreakerMetadata?: { totalCalls: number; circuitReason?: string };
  outputGuardMetadata?: { totalLength: number; tripped: boolean; reason?: string; firstByteLatencyMs?: number };
}

/** 动态上下文（与 Pi 的 DynamicContext 结构匹配） */
export interface DynamicContext {
  sessionSummary?: string;
  /** 对话工作区绝对路径 */
  workspacePath?: string;
}

/** invoke() 选项 */
export interface InvokeOptions {
  dynamicContext?: DynamicContext;
  conversationId: string;
  /** 当前 streaming 消息 ID（speak 工具需要） */
  messageId?: string;
  onEvent?: (event: AgentStreamEvent) => void;
}

export interface AgentInvokePort {
  invoke(otterId: string, message: string, options?: InvokeOptions): Promise<AgentRunResult>;
  /** 中断指定 Otter 的 Agent 生成（messageId 用于定位并发 session） */
  abort(otterId: string, messageId?: string): void;
  /** 获取指定 Otter 当前 session 的工具调用次数 */
  getToolCallCount(otterId: string, messageId?: string): number;
  /** 查询内部 abort 原因（OutputGuard 触发等），返回 undefined 表示非内部 abort */
  getInternalAbortReason(messageId: string): string | undefined;
}
