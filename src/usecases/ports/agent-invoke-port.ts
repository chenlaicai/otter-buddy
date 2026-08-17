/**
 * Agent 调用端口接口（usecases 层定义，interface-adapters 层实现）
 * 遵循分层架构：usecases 不能直接依赖 interface-adapters
 *
 * ⚠️ 命名区分（R20260817arnt PR-A）：本接口是 **invokeConversation 粒度**（一轮对话发言，
 * scheduler/recruiting/飞书派发使用）；SDK 级 invoke 粒度的端口是 SdkInvokePort
 * （sdk-invoke-port.ts，PiSessionFactory 结构匹配）。PR-D1 时本文件将随
 * AgentTurnPort 的引入而删除——勿在此新增消费方。
 */
export interface AgentInvokeResult {
  messageId: string;
  aggregatedTargets?: string[];
}

export interface AgentInvokePort {
  invokeConversation(params: {
    otterId: string;
    conversationId: string;
    userMessageContent: string;
    senderId: string;
    onSSEEvent?: (event: { event: string; data: Record<string, unknown> }) => void;
  }): Promise<AgentInvokeResult>;
}

/**
 * AgentInvoker 的接口定义（用于类型安全的适配）
 */
interface AgentInvokerLike {
  invokeConversation(params: {
    otterId: string;
    conversationId: string;
    userMessageContent: string;
    senderId: string;
    onSSEEvent?: (event: unknown) => void;
  }): Promise<{ messageId: string }>;
}

/**
 * 将 AgentInvoker 适配为 AgentInvokePort
 */
export class AgentInvokePortAdapter implements AgentInvokePort {
  constructor(private readonly agentInvoker: AgentInvokerLike) {}

  async invokeConversation(params: {
    otterId: string;
    conversationId: string;
    userMessageContent: string;
    senderId: string;
    onSSEEvent?: (event: unknown) => void;
  }): Promise<AgentInvokeResult> {
    return this.agentInvoker.invokeConversation(params);
  }
}
