import type { ManageConnection } from "@usecases/im/manage-connection";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { CommandDispatcher } from "./command-dispatcher";
import type { FeishuGateway } from "@usecases/im/feishu-gateway";
import type { AgentDispatchService } from "@usecases/conversation/agent-dispatch-service";
import type { FeishuLongConnectionGateway, FeishuLongConnectionMessage } from "@usecases/im/feishu-long-connection-gateway";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { Logger } from "@usecases/ports/logger";

export class FeishuLongConnectionHandler {
  constructor(
    private readonly deps: {
      manageConnection: ManageConnection;
      sendMessage: SendMessage;
      commandDispatcher: CommandDispatcher;
      feishuGateway: FeishuGateway;
      agentDispatchService: AgentDispatchService;
      longConnectionGateway: FeishuLongConnectionGateway;
      messageBroadcaster: MessageBroadcaster;
      logger: Logger;
    },
  ) {}

  /** 启动长连接 */
  async start(): Promise<void> {
    // 注册消息处理器
    this.deps.longConnectionGateway.onMessage((msg) => {
      this.handleMessage(msg);
    });

    // 启动长连接
    await this.deps.longConnectionGateway.start();
  }

  /** 停止长连接 */
  async stop(): Promise<void> {
    await this.deps.longConnectionGateway.stop();
  }

  private async handleMessage(msg: FeishuLongConnectionMessage): Promise<void> {
    const { chatId, text, senderId, messageId } = msg;

    this.deps.logger.info("Received Feishu message via long connection", {
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
      this.deps.logger.error("Failed to broadcast feishu message to web", err instanceof Error ? err : undefined, {
        conversationId: conversation.id,
        messageId: message.id,
      });
    });

    // 异步触发 Agent 派发
    this.triggerAgentDispatch(conversation.id, text, senderId, chatId);
  }

  private triggerAgentDispatch(
    conversationId: string,
    userMessageContent: string,
    senderId: string,
    _chatId: string,
  ): void {
    // 异步执行，不阻塞消息处理
    // 注意：不在这里发送回复到飞书，由 MessageBroadcaster 统一处理消息同步
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
      }
    }).catch(err => {
      this.deps.logger.error("Agent dispatch exception", err instanceof Error ? err : undefined, {
        conversationId,
      });
    });
  }
}
