import type { QueryMessage } from "./query-message";
import type { AgentInvokePort } from "@usecases/ports/agent-invoke-port";
import type { Logger } from "@usecases/ports/logger";
import type { DispatchChainEngine } from "./dispatch-chain-engine";

export interface AgentDispatchResult {
  otterReply?: string;
  error?: string;
}

export class AgentDispatchService {
  constructor(
    private readonly deps: {
      dispatchChainEngine: DispatchChainEngine;
      queryMessage: QueryMessage;
      agentInvokePort: AgentInvokePort;
      logger: Logger;
    },
  ) {}

  /** 触发 Agent 派发（非 SSE 模式，用于飞书路径） */
  async dispatchWithoutSSE(
    conversationId: string,
    userMessageContent: string,
    senderId: string,
  ): Promise<AgentDispatchResult> {
    try {
      // 获取首轮目标
      const firstTurnTargets = await this.resolveFirstTurnTargets(conversationId);
      if (firstTurnTargets.length === 0) {
        return { error: "无可用的 Otter 参与者" };
      }

      // 执行发言链
      const result = await this.deps.dispatchChainEngine.executeChain({
        conversationId,
        userMessageContent,
        senderId,
        initialTargets: firstTurnTargets,
        invokeFn: async (params) => {
          return this.deps.agentInvokePort.invokeConversation({
            otterId: params.otterId,
            conversationId: params.conversationId,
            userMessageContent: params.userMessageContent,
            senderId: params.senderId,
          });
        },
      });

      return { otterReply: result.otterReply };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.logger.error('Agent 派发异常', err instanceof Error ? err : new Error(msg), { conversationId });
      return { error: `Agent 派发失败: ${msg}` };
    }
  }

  private async resolveFirstTurnTargets(conversationId: string): Promise<string[]> {
    // 获取最新用户消息的 talkingStonePassedTo
    const messages = await this.deps.queryMessage.getMessages(conversationId, { limit: 1, senderType: "user" });
    if (messages.length === 0) return [];

    const lastUserMsg = messages[0];
    const targets = lastUserMsg.talkingStonePassedTo ?? [];

    this.deps.logger.info('resolveFirstTurnTargets', {
      conversationId,
      messageId: lastUserMsg.id,
      talkingStonePassedTo: targets,
    });

    return targets;
  }
}
