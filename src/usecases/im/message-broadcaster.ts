import type { Message } from "@entities/conversation/message";
import type { ManageConnection } from "./manage-connection";
import type { FeishuGateway } from "./feishu-gateway";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";
import type { SSEEvent } from "@contract/sse/events";
import { projectForChannel } from "@entities/conversation/message-body-projection";

/**
 * 思考中消息的最大允许延迟(审视 R5):超过此延迟说明 IO 慢且 agent 可能已完成,
 * 此时发"正在思考..."会晚于最终消息造成乱序,跳过。
 */
const THINKING_MESSAGE_MAX_DELAY_MS = 3000;

/**
 * 消息广播服务
 * 负责将消息同步到所有连接的客户端(Web 和飞书)
 *
 * 飞书信道适配(F20260812fmdr):
 * - 最终消息: projectForChannel 投影 → replyMarkdown 走 post + md 富文本
 * - 思考中消息: message.start 事件触发 → replyText 发 `[otter名] 正在思考...`
 * - 降级: replyMarkdown 失败时由 client.ts 自动降级到 replyText 带 [纯文本降级] 前缀
 */
export class MessageBroadcaster {
  // Web 端的消息订阅者(conversationId -> Set<callback>)
  private webSubscribers = new Map<string, Set<(message: Message) => void>>();
  // Web 端的事件订阅者(conversationId -> Set<callback>),用于转发 agent streaming 事件
  private eventSubscribers = new Map<string, Set<(event: SSEEvent) => void>>();

  constructor(
    private readonly manageConnection: ManageConnection,
    private readonly feishuGateway: FeishuGateway,
    private readonly queryOtter: QueryOtter,
    private readonly logger: Logger,
    /** Web 端 base URL,用于飞书侧 html-card 占位符拼接跳转链接 */
    private readonly webBaseUrl?: string,
  ) {}

  /**
   * Web 端订阅消息和事件
   * 返回取消订阅函数(同时清理消息和事件订阅)
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

    // 注册事件订阅(可选)
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
    // 1. 广播到 Web 端(通过 SSE 回调)
    this.broadcastToWeb(message);

    // 2. 广播到飞书端(如果有连接绑定到该对话)
    await this.broadcastToFeishu(message);
  }

  /**
   * 广播 SSE 事件到 Web 端订阅者
   * 用于飞书路径的 agent streaming 事件转发
   *
   * 副作用(F20260812fmdr): 当 event === "message.start" 且会话有飞书绑定时,
   * 触发"正在思考..."临时消息发送,消除飞书侧 30-60s 静默。
   */
  broadcastEvent(conversationId: string, event: SSEEvent): void {
    // 飞书侧思考中消息(message.start 触发,fire-and-forget)
    if (event.event === "message.start") {
      this.maybeSendFeishuThinkingMessage(conversationId, event).catch((err) => {
        this.logger.error("Failed to send feishu thinking message", err instanceof Error ? err : undefined, {
          conversationId,
        });
      });
    }

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
    // Web 用户消息不推送给 Web 订阅者(发送方已有本地消息,避免重复)
    // 飞书用户消息需要推送给 Web(跨接入点同步)
    if (message.senderType === "user" && message.source === "web") {
      return;
    }

    const subscribers = this.webSubscribers.get(message.conversationId);
    if (!subscribers || subscribers.size === 0) {
      this.logger.info("[broadcastToWeb] 无订阅者,跳过", {
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

    const senderLabel = await this.resolveSenderLabel(message);
    const body = message.body ?? "(空消息)";
    const markdown = projectForChannel(body, {
      webBaseUrl: this.webBaseUrl,
      conversationId: message.conversationId,
    });

    try {
      await this.feishuGateway.replyMarkdown(connection.externalId, senderLabel, markdown);
      this.logger.info("Markdown message broadcast to Feishu", {
        conversationId: message.conversationId,
        messageId: message.id,
        chatId: connection.externalId,
      });
    } catch (err) {
      // replyMarkdown 内部已有降级到 replyText 的兜底;只有降级本身失败才会冒泡到这里
      this.logger.error("Failed to broadcast to Feishu (degradation also failed)", err instanceof Error ? err : undefined, {
        conversationId: message.conversationId,
        messageId: message.id,
      });
    }
  }

  /**
   * message.start 触发的飞书"正在思考..."临时消息(消除 IM 静默期)
   *
   * 时间戳 gate(审视 R5): 发送前检查距 message.start.createdAt 的延迟,
   * 超过阈值(3s)说明 IO 慢且 agent 可能已完成、最终消息可能已到达 —— 此时发
   * "正在思考..." 会晚于最终消息造成乱序,跳过。
   */
  private async maybeSendFeishuThinkingMessage(conversationId: string, event: SSEEvent): Promise<void> {
    const data = event.data as { otterName?: string; createdAt?: string };
    const otterName = data.otterName;
    if (!otterName) return;

    // 时间戳 gate:createdAt 是 ISO string,转 ms 比对
    if (data.createdAt) {
      const elapsedMs = Date.now() - new Date(data.createdAt).getTime();
      // 非法 createdAt → NaN:显式当作"无 gate 信息",继续发送(与 createdAt 缺失同语义)
      if (!Number.isNaN(elapsedMs) && elapsedMs > THINKING_MESSAGE_MAX_DELAY_MS) {
        this.logger.info("Skip feishu thinking message: too slow, final message likely already sent", {
          conversationId,
          otterName,
          elapsedMs,
        });
        return;
      }
    }

    const session = await this.manageConnection.getSessionByConversation(conversationId);
    if (!session) return;
    const connection = await this.manageConnection.getConnection(session.connectionId);
    if (!connection) return;

    try {
      await this.feishuGateway.replyText(connection.externalId, `[${otterName}] 正在思考...`);
      this.logger.info("Feishu thinking message sent", { conversationId, otterName });
    } catch (err) {
      this.logger.error("Failed to send feishu thinking message", err instanceof Error ? err : undefined, {
        conversationId,
      });
    }
  }

  /** 解析发送者显示标签(用于飞书 post title) */
  private async resolveSenderLabel(message: Message): Promise<string> {
    if (message.senderType === "user") return "用户";
    if (message.senderType === "otter") {
      const otter = await this.queryOtter.getById(message.senderId);
      return otter?.name ?? message.senderId;
    }
    return "系统";
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
}
