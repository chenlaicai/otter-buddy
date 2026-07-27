/**
 * Agent 调用端口：描述"驱动 Agent 生成"的能力。
 * PiSessionFactory (frameworks 层) 的 invoke() 方法结构匹配此接口。
 */

/** Agent 流式事件（与 Pi 的 AgentEvent 结构匹配） */
export interface AgentStreamEvent {
  type: string;
  delta?: string;
  [key: string]: unknown;
}

/** Agent 执行结果（与 Pi 的 AgentRunResult 结构匹配） */
export interface AgentRunResult {
  text: string;
  tokenUsage?: { input: number; output: number };
  ctxMax?: number;
  circuitBreakerMetadata?: { totalCalls: number; circuitReason?: string };
  outputGuardMetadata?: { totalLength: number; tripped: boolean; reason?: string };
}

/** 动态上下文（与 Pi 的 DynamicContext 结构匹配） */
export interface DynamicContext {
  sessionSummary?: string;
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
}
