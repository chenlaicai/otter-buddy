import type { Context } from "hono";
import type { ManageConnection } from "@usecases/im/manage-connection";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { CommandDispatcher } from "./command-dispatcher";
import type { FeishuGateway } from "@usecases/im/feishu-gateway";
import type { Logger } from "@usecases/ports/logger";

interface FeishuEvent {
  schema?: string;
  header?: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
    tenant_key: string;
  };
  event?: {
    message?: {
      message_id: string;
      root_id?: string;
      parent_id?: string;
      create_time: string;
      chat_id: string;
      chat_type: string;
      message_type: string;
      content: string;
      mentions?: Array<{
        key: string;
        id: {
          union_id: string;
          user_id: string;
          open_id: string;
        };
        name: string;
        tenant_key: string;
      }>;
    };
    sender?: {
      sender_id: {
        union_id: string;
        user_id: string;
        open_id: string;
      };
      sender_type: string;
      tenant_key: string;
    };
  };
  challenge?: string;
  token?: string;
  type?: string;
}

export interface FeishuWebhookConfig {
  verificationToken?: string;
}

export class FeishuWebhookHandler {
  constructor(
    private readonly deps: {
      manageConnection: ManageConnection;
      sendMessage: SendMessage;
      commandDispatcher: CommandDispatcher;
      feishuGateway: FeishuGateway;
      config: FeishuWebhookConfig;
      logger: Logger;
    },
  ) {}

  async handle(c: Context): Promise<Response> {
    try {
      const body = await c.req.text();
      const event = JSON.parse(body) as FeishuEvent;

      // 处理 URL Verification Challenge
      if (event.challenge) {
        return c.json({ challenge: event.challenge });
      }

      // 验证 verification token
      if (this.deps.config.verificationToken && event.header?.token !== this.deps.config.verificationToken) {
        this.deps.logger.warn("Invalid Feishu verification token");
        return c.json({ error: "Invalid token" }, 403);
      }

      // 处理消息事件
      if (event.header?.event_type === "im.message.receive_v1" && event.event?.message) {
        await this.handleMessage(event);
      }

      return c.json({ code: 0 });
    } catch (err) {
      this.deps.logger.error("Feishu webhook error", err instanceof Error ? err : undefined);
      return c.json({ error: "Internal server error" }, 500);
    }
  }

  private async handleMessage(event: FeishuEvent): Promise<void> {
    const message = event.event!.message!;
    const sender = event.event!.sender!;

    // 只处理文本消息
    if (message.message_type !== "text") {
      this.deps.logger.info("Ignoring non-text message", { messageType: message.message_type });
      return;
    }

    // 忽略机器人自己的消息
    if (sender.sender_type === "app") {
      return;
    }

    const chatId = message.chat_id;
    const content = JSON.parse(message.content) as { text: string };
    const text = content.text.trim();

    this.deps.logger.info("Received Feishu message", {
      chatId,
      messageId: message.message_id,
      textLength: text.length,
    });

    // 确保 Connection 存在
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

    // 发送消息到 Conversation
    await this.deps.sendMessage.send({
      conversationId: conversation.id,
      senderId: sender.sender_id.open_id,
      senderType: "user",
      talkingStonePassedTo: [],
      body: text,
      source: "feishu",
    });

    this.deps.logger.info("Message forwarded to conversation", {
      connectionId: connection.id,
      conversationId: conversation.id,
      messageId: message.message_id,
    });
  }
}
