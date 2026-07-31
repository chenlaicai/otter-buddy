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
    this.deps.agentDispatchService.dispatchWithoutSSE(
      conversationId,
      userMessageContent,
      senderId,
    ).then(result => {
      if (result.error) {
        this.deps.logger.error("Agent dispatch failed", undefined, {
          conversationId,
          error: result.error,
        });
        return;
      }
      // Agent 回复同步到飞书端（带名字前缀）
      if (result.messageId && result.otterReply) {
        // 构造最小 Message 对象（broadcastToFeishu 只用 id/conversationId/senderType/senderId/body/source）
        const agentMsg = {
          id: result.messageId,
          conversationId,
          turnId: "",
          senderType: "otter" as const,
          senderId: "",
          talkingStonePassedTo: null,
          status: "completed" as const,
          body: result.otterReply,
          sequenceNum: 0,
          contextTokens: null,
          contextTokensMax: null,
          source: "web" as const,
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
        this.deps.messageBroadcaster.broadcastToFeishuOnly(agentMsg).catch(err => {
          this.deps.logger.error("Failed to broadcast agent reply to Feishu", err instanceof Error ? err : undefined, {
            conversationId,
            messageId: result.messageId,
          });
        });
      }
    }).catch(err => {
      this.deps.logger.error("Agent dispatch exception", err instanceof Error ? err : undefined, {
        conversationId,
      });
    });
  }
}
