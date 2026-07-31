import type { QueryMessage } from "./query-message";
import type { AgentInvokePort } from "@usecases/ports/agent-invoke-port";
import type { Logger } from "@usecases/ports/logger";
import type { DispatchChainEngine } from "./dispatch-chain-engine";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";

/** 不转发到 subscription 的事件（stream.end 会关闭 SSE 流，不适合长连接） */
const EXCLUDED_EVENTS = new Set(["stream.end"]);

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
      agentInvokePort: AgentInvokePort;
      logger: Logger;
      messageBroadcaster?: MessageBroadcaster;
    },
  ) {}

  /** 触发 Agent 派发（非 SSE 模式，用于飞书路径；streaming 事件通过 subscription 转发） */
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

      let lastMessageId: string | undefined;

      // 执行发言链，streaming 事件通过 MessageBroadcaster 转发到 Web 订阅者
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
            onSSEEvent: this.deps.messageBroadcaster
              ? (event) => {
                  if (!EXCLUDED_EVENTS.has(event.event)) {
                    this.deps.messageBroadcaster!.broadcastEvent(conversationId, event);
                  }
                }
              : undefined,
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
