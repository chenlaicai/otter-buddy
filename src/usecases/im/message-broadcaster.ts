import type { Message } from "@entities/conversation/message";
import type { ManageConnection } from "./manage-connection";
import type { FeishuGateway } from "./feishu-gateway";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";

/** SSE 事件（与 sse-streamer.ts 中的 SSEEvent 兼容） */
interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * 消息广播服务
 * 负责将消息同步到所有连接的客户端（Web 和飞书）
 */
export class MessageBroadcaster {
  // Web 端的消息订阅者（conversationId -> Set<callback>）
  private webSubscribers = new Map<string, Set<(message: Message) => void>>();
  // Web 端的事件订阅者（conversationId -> Set<callback>），用于转发 agent streaming 事件
  private eventSubscribers = new Map<string, Set<(event: SSEEvent) => void>>();

  constructor(
    private readonly manageConnection: ManageConnection,
    private readonly feishuGateway: FeishuGateway,
    private readonly queryOtter: QueryOtter,
    private readonly logger: Logger,
  ) {}

  /**
   * Web 端订阅消息和事件
   * 返回取消订阅函数（同时清理消息和事件订阅）
   */
  subscribe(
    conversationId: string,
    onMessage: (message: Message) => void,
    onEvent?: (event: SSEEvent) => void,
  ): () => void {
    // 注册消息订阅
    if (!this.webSubscribers.has(conversationId)) {
      this.webSubscribers.set(conversationId, new Set());
    }
    this.webSubscribers.get(conversationId)!.add(onMessage);

    // 注册事件订阅（可选）
    if (onEvent) {
      if (!this.eventSubscribers.has(conversationId)) {
        this.eventSubscribers.set(conversationId, new Set());
      }
      this.eventSubscribers.get(conversationId)!.add(onEvent);
    }

    this.logger.info("Web subscriber added", {
      conversationId,
      subscriberCount: this.webSubscribers.get(conversationId)!.size,
    });

    // 返回取消订阅函数
    return () => {
      const msgSubs = this.webSubscribers.get(conversationId);
      if (msgSubs) {
        msgSubs.delete(onMessage);
        if (msgSubs.size === 0) this.webSubscribers.delete(conversationId);
      }
      if (onEvent) {
        const evtSubs = this.eventSubscribers.get(conversationId);
        if (evtSubs) {
          evtSubs.delete(onEvent);
          if (evtSubs.size === 0) this.eventSubscribers.delete(conversationId);
        }
      }
      this.logger.info("Web subscriber removed", {
        conversationId,
        remainingCount: msgSubs?.size ?? 0,
      });
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
   * 广播 SSE 事件到 Web 端订阅者
   * 用于飞书路径的 agent streaming 事件转发
   */
  broadcastEvent(conversationId: string, event: SSEEvent): void {
    const subscribers = this.eventSubscribers.get(conversationId);
    if (!subscribers || subscribers.size === 0) {
      this.logger.info("[broadcastEvent] 无事件订阅者", { conversationId, event: event.event });
      return;
    }
    this.logger.info("[broadcastEvent] 推送事件", { conversationId, event: event.event, subscriberCount: subscribers.size });

    for (const callback of subscribers) {
      try {
        callback(event);
      } catch (err) {
        this.logger.error("Failed to broadcast event to Web subscriber", err instanceof Error ? err : undefined, {
          conversationId,
          event: event.event,
        });
      }
    }
  }

  private broadcastToWeb(message: Message): void {
    // Web 用户消息不推送给 Web 订阅者（发送方已有本地消息，避免重复）
    // 飞书用户消息需要推送给 Web（跨接入点同步）
    if (message.senderType === "user" && message.source === "web") {
      return;
    }

    const subscribers = this.webSubscribers.get(message.conversationId);
    if (!subscribers || subscribers.size === 0) {
      this.logger.info("[broadcastToWeb] 无订阅者，跳过", {
        conversationId: message.conversationId,
        messageId: message.id,
        senderType: message.senderType,
        source: message.source,
      });
      return;
    }

    this.logger.info("[broadcastToWeb] 推送消息到 Web", {
      conversationId: message.conversationId,
      messageId: message.id,
      senderType: message.senderType,
      source: message.source,
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
    if (!this.shouldBroadcastToFeishu(message)) return;

    const session = await this.manageConnection.getSessionByConversation(message.conversationId);
    if (!session) return;

    const connection = await this.manageConnection.getConnection(session.connectionId);
    if (!connection) return;

    const text = await this.buildFeishuMessageText(message);

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

  /** 判断消息是否应该广播到飞书 */
  private shouldBroadcastToFeishu(message: Message): boolean {
    if (message.senderType === "system") return false;
    if (message.source === "feishu") {
      this.logger.debug("Skipping feishu message broadcast (source=feishu)", {
        messageId: message.id,
        conversationId: message.conversationId,
      });
      return false;
    }
    return true;
  }

  /** 构建飞书消息文本（带发送者前缀） */
  private async buildFeishuMessageText(message: Message): Promise<string> {
    const body = message.body ?? "(空消息)";
    if (message.senderType === "user") return `[用户] ${body}`;
    if (message.senderType === "otter") {
      const otter = await this.queryOtter.getById(message.senderId);
      return `[${otter?.name ?? message.senderId}] ${body}`;
    }
    return body;
  }
}
