/**
 * Agent 调用端口接口（usecases 层定义，interface-adapters 层实现）
 * 遵循分层架构：usecases 不能直接依赖 interface-adapters
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
