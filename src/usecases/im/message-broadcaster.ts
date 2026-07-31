import type { Message } from "@entities/conversation/message";
import type { ManageConnection } from "./manage-connection";
import type { FeishuGateway } from "./feishu-gateway";
import type { Logger } from "@usecases/ports/logger";

/**
 * 消息广播服务
 * 负责将消息同步到所有连接的客户端（Web 和飞书）
 */
export class MessageBroadcaster {
  // Web 端的订阅者（conversationId -> Set<callback>）
  private webSubscribers = new Map<string, Set<(message: Message) => void>>();

  constructor(
    private readonly manageConnection: ManageConnection,
    private readonly feishuGateway: FeishuGateway,
    private readonly logger: Logger,
  ) {}

  /**
   * Web 端订阅消息
   * 返回取消订阅函数
   */
  subscribe(conversationId: string, callback: (message: Message) => void): () => void {
    if (!this.webSubscribers.has(conversationId)) {
      this.webSubscribers.set(conversationId, new Set());
    }
    this.webSubscribers.get(conversationId)!.add(callback);

    this.logger.info("Web subscriber added", {
      conversationId,
      subscriberCount: this.webSubscribers.get(conversationId)!.size,
    });

    // 返回取消订阅函数
    return () => {
      const subscribers = this.webSubscribers.get(conversationId);
      if (subscribers) {
        subscribers.delete(callback);
        if (subscribers.size === 0) {
          this.webSubscribers.delete(conversationId);
        }
      }
      this.logger.info("Web subscriber removed", { conversationId });
    };
  }

  /**
   * 广播消息到所有连接的客户端
   * 当消息完成时调用
   */
  async broadcast(message: Message): Promise<void> {
    // 1. 广播到 Web 端（通过 SSE 回调）
    this.broadcastToWeb(message);

    // 2. 广播到飞书端（如果有连接绑定到该对话）
    await this.broadcastToFeishu(message);
  }

  /**
   * 仅广播到飞书端
   * 用于 Web 端发消息时，同步到飞书（Web 端已有 SSE 流，不需要重复广播）
   */
  async broadcastToFeishuOnly(message: Message): Promise<void> {
    await this.broadcastToFeishu(message);
  }

  private broadcastToWeb(message: Message): void {
    const subscribers = this.webSubscribers.get(message.conversationId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    this.logger.info("Broadcasting to Web", {
      conversationId: message.conversationId,
      messageId: message.id,
      subscriberCount: subscribers.size,
    });

    for (const callback of subscribers) {
      try {
        callback(message);
      } catch (err) {
        this.logger.error("Failed to broadcast to Web subscriber", err instanceof Error ? err : undefined, {
          conversationId: message.conversationId,
          messageId: message.id,
        });
      }
    }
  }

  private async broadcastToFeishu(message: Message): Promise<void> {
    // 只同步用户消息和 Otter 回复（不同步系统消息）
    if (message.senderType === "system") {
      return;
    }

    // 不同步飞书来源的消息（防止回环）
    if (message.source === "feishu") {
      return;
    }

    // 查找绑定到该对话的飞书连接
    const session = await this.manageConnection.getSessionByConversation(message.conversationId);
    if (!session) {
      return;
    }

    // 获取连接信息
    const connection = await this.manageConnection.getConnection(session.connectionId);
    if (!connection) {
      return;
    }

    // 构建消息文本（Otter 回复不加前缀，用户消息加前缀）
    const text = message.senderType === "user"
      ? `[用户] ${message.body ?? "(空消息)"}`
      : (message.body ?? "(空消息)");

    try {
      await this.feishuGateway.replyText(connection.externalId, text);
      this.logger.info("Message broadcast to Feishu", {
        conversationId: message.conversationId,
        messageId: message.id,
        chatId: connection.externalId,
      });
    } catch (err) {
      this.logger.error("Failed to broadcast to Feishu", err instanceof Error ? err : undefined, {
        conversationId: message.conversationId,
        messageId: message.id,
      });
    }
  }
}
