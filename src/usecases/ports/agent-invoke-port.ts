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
