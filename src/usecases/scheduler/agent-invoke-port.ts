/**
 * Agent 调用端口接口（usecases 层定义，interface-adapters 层实现）
 * 遵循分层架构：usecases 不能直接依赖 interface-adapters
 */
export interface AgentInvokePort {
  invokeConversation(params: {
    otterId: string;
    conversationId: string;
    userMessageContent: string;
    senderId: string;
  }): Promise<{ messageId: string }>;
}

/**
 * 将 AgentInvoker 适配为 AgentInvokePort
 */
export class AgentInvokePortAdapter implements AgentInvokePort {
  constructor(private readonly agentInvoker: { invokeConversation: (params: any) => Promise<any> }) {}

  async invokeConversation(params: {
    otterId: string;
    conversationId: string;
    userMessageContent: string;
    senderId: string;
  }): Promise<{ messageId: string }> {
    return this.agentInvoker.invokeConversation(params);
  }
}
