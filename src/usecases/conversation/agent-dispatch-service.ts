import type { QueryMessage } from "./query-message";
import type { AgentTurnPort } from "@usecases/ports/agent-turn-port";
import type { Logger } from "@usecases/ports/logger";
import type { DispatchChainEngine } from "./dispatch-chain-engine";

export interface AgentDispatchResult {
  otterReply?: string;
  messageId?: string;
  error?: string;
}

export class AgentDispatchService {
  constructor(
    private readonly deps: {
      dispatchChainEngine: DispatchChainEngine;
      queryMessage: QueryMessage;
      agentInvokePort: AgentTurnPort;
      logger: Logger;
    },
  ) {}

  /** 触发 Agent 派发（用于飞书等非 Web 路径；事件通过 AgentInvoker 内部的 broadcastEvent 统一推送） */
  async dispatch(
    conversationId: string,
    userMessageContent: string,
    senderId: string,
  ): Promise<AgentDispatchResult> {
    try {
      const firstTurnTargets = await this.resolveFirstTurnTargets(conversationId);
      if (firstTurnTargets.length === 0) {
        return { error: "无可用的 Otter 参与者" };
      }

      let lastMessageId: string | undefined;

      const result = await this.deps.dispatchChainEngine.executeChain({
        conversationId,
        userMessageContent,
        senderId,
        initialTargets: firstTurnTargets,
        invokeFn: async (params) => {
          const invokeResult = await this.deps.agentInvokePort.invokeConversation({
            otterId: params.otterId,
            conversationId: params.conversationId,
            userMessageContent: params.userMessageContent,
            senderId: params.senderId,
          });
          lastMessageId = invokeResult.messageId;
          return invokeResult;
        },
      });

      return { otterReply: result.otterReply, messageId: lastMessageId };
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
