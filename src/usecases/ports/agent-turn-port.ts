/**
 * Agent 发言轮端口（usecases 层定义，interface-adapters 层实现）
 *
 * Why: 替代旧 AgentInvokePort（PR-D1 删除）。接口对齐 AgentInvoker 实际能力，
 * 干掉 AgentInvokePortAdapter 多余包装层。AgentInvoker 直接实现本接口。
 *
 * 旧 AgentInvokePort 的 invokeConversation 返回 { messageId, aggregatedTargets? }；
 * 本端口扩展为完整 TurnResult（含 duration、tokenUsage），与 orchestrator 对齐。
 */
import type { SSEEvent } from "@contract/sse/events";

/** Agent 发言轮结果 */
export interface AgentTurnResult {
  messageId: string;
  duration: number;
  tokenUsage?: { input: number; output: number };
  aggregatedTargets?: string[];
}

export interface AgentTurnPort {
  /** 执行一轮 Agent 对话 */
  invokeConversation(params: {
    otterId: string;
    conversationId: string;
    userMessageContent: string;
    senderId: string;
    onSSEEvent?: (event: SSEEvent) => void;
    retryCount?: number;
    /** Web 手动重试标识（metrics retry label 区分 manual/auto） */
    manualRetry?: boolean;
    /** 多模态 Phase 1：当前任务消息携带的图片（ImageContent；≤2 图由服务端硬限制把关） */
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
  }): Promise<AgentTurnResult>;

  /** 中止 Agent 生成 */
  abort(otterId: string, messageId: string): void;
}
