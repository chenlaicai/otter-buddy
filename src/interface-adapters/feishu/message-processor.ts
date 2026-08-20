import type { ManageConnection } from "@usecases/im/manage-connection";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { CommandDispatcher } from "./command-dispatcher";
import type { FeishuGateway } from "@usecases/im/feishu-gateway";
import type { AgentDispatchService } from "@usecases/conversation/agent-dispatch-service";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { Logger } from "@usecases/ports/logger";

export interface FeishuIncomingMessage {
  chatId: string;
  text: string;
  senderId: string;
  messageId: string;
}

export class FeishuMessageProcessor {
  constructor(
    private readonly deps: {
      manageConnection: ManageConnection;
      sendMessage: SendMessage;
      commandDispatcher: CommandDispatcher;
      feishuGateway: FeishuGateway;
      agentDispatchService: AgentDispatchService;
      messageBroadcaster: MessageBroadcaster;
      logger: Logger;
    },
  ) {}

  async process(msg: FeishuIncomingMessage): Promise<void> {
    const { chatId, text, senderId, messageId } = msg;

    this.deps.logger.info("Processing Feishu message", {
      chatId,
      messageId,
      textLength: text.length,
    });

    const connection = await this.deps.manageConnection.ensureConnection(chatId, chatId);

    // 判断是否是命令
    if (text.startsWith("/")) {
      await this.deps.commandDispatcher.dispatch(connection.id, text, chatId);
      return;
    }

    // 普通消息：发送到当前绑定的 Conversation
    const conversation = await this.deps.manageConnection.getCurrentConversation(connection.id);
    if (!conversation) {
      await this.deps.feishuGateway.replyText(
        chatId,
        "当前未进入任何对话，请先使用 /in <对话ID> 进入对话\n\n使用 /list 查看可用对话"
      );
      return;
    }

    // 存消息
    const message = await this.deps.sendMessage.send({
      conversationId: conversation.id,
      senderId,
      senderType: "user",
      talkingStonePassedTo: [],
      body: text,
      source: "feishu",
    });

    this.deps.logger.info("Message saved to conversation", {
      connectionId: connection.id,
      conversationId: conversation.id,
      messageId: message.id,
    });

    // F20260820i333: @提及解析失败时发送 feedback 给用户
    if ('mentionFeedback' in message && message.mentionFeedback) {
      await this.deps.feishuGateway.replyText(chatId, message.mentionFeedback as string).catch(err => {
        this.deps.logger.error("Failed to send mention feedback", err instanceof Error ? err : undefined, {
          conversationId: conversation.id,
        });
      });
    }

    // 广播飞书消息到 Web 端（实时同步）
    this.deps.messageBroadcaster.broadcast(message).catch(err => {
      this.deps.logger.error("Failed to broadcast feishu message", err instanceof Error ? err : undefined, {
        conversationId: conversation.id,
        messageId: message.id,
      });
    });

    // 异步触发 Agent 派发
    this.triggerAgentDispatch(conversation.id, text, senderId);
  }

  private triggerAgentDispatch(
    conversationId: string,
    userMessageContent: string,
    senderId: string,
  ): void {
    // 异步执行，不阻塞消息处理
    // Agent 事件通过 AgentInvoker.broadcastEvent 统一推送给所有订阅者
    // Agent 完成消息通过 AgentInvoker.broadcast 统一推送到外部渠道
    this.deps.agentDispatchService.dispatch(
      conversationId,
      userMessageContent,
      senderId,
    ).then(result => {
      if (result.error) {
        this.deps.logger.error("Agent dispatch failed", undefined, {
          conversationId,
          error: result.error,
        });
      }
    }).catch(err => {
      this.deps.logger.error("Agent dispatch exception", err instanceof Error ? err : undefined, {
        conversationId,
      });
    });
  }
}
