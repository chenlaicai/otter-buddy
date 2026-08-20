import type { Message } from "@entities/conversation/message";
import type { Logger } from "@usecases/ports/logger";
import type { SSEEvent } from "@contract/sse/events";

/**
 * 进程内消息广播总线（issue #281）。
 *
 * 职责：Web SSE 订阅者的消息/事件分发 + 出站通道（outbound channel）的注册与转发。
 * **平台无关**：此前本类混入飞书出站逻辑且仅在飞书配置存在时由 bootstrap 创建——
 * web-only 部署（不配飞书）下 POST 发送流只剩 stream.end、GET subscribe 对
 * undefined 调 subscribe 直接抛错，整条流式链路断流。
 *
 * 现由 bootstrap **无条件创建**；飞书出站（markdown 投递 / "正在思考..."消息）
 * 拆至 FeishuMessageChannel，作为 outbound channel 在飞书启用时注册。
 */
export interface OutboundMessageChannel {
  /** 最终消息出站。broadcast 按注册序逐通道 await，**逐通道 catch 隔离**——
   *  单通道失败不阻塞后续通道，错误记日志后继续。 */
  onMessage(message: Message): Promise<void>;
}

export interface OutboundEventChannel {
  /** streaming 事件出站（fire-and-forget，如飞书 message.start 的"正在思考..."） */
  onEvent(conversationId: string, event: SSEEvent): void;
}

export class MessageBroadcaster {
  // Web 端的消息订阅者(conversationId -> Set<callback>)
  private webSubscribers = new Map<string, Set<(message: Message) => void>>();
  // Web 端的事件订阅者(conversationId -> Set<callback>),用于转发 agent streaming 事件
  private eventSubscribers = new Map<string, Set<(event: SSEEvent) => void>>();
  // 出站通道（飞书等外部 IM；按注册序调用）
  private messageChannels: OutboundMessageChannel[] = [];
  private eventChannels: OutboundEventChannel[] = [];
  // #241: 幂等性去重——最近广播过的 messageId 集合（进程内 LRU）
  private recentBroadcasts = new Set<string>();
  private static readonly DEDUP_MAX_SIZE = 1000;

  constructor(private readonly logger: Logger) {}

  /** 注册出站通道（bootstrap 在对应平台启用时调用） */
  registerOutboundChannel(channel: OutboundMessageChannel & OutboundEventChannel): void {
    this.messageChannels.push(channel);
    this.eventChannels.push(channel);
  }

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
   * 广播消息到所有连接的客户端（Web 订阅者 + 出站通道）
   * 当消息完成时调用
   */
  async broadcast(message: Message): Promise<void> {
    // #241: 幂等性去重——同一 messageId 不重复广播
    if (this.recentBroadcasts.has(message.id)) {
      this.logger.info('[broadcast] 幂等去重，跳过重复广播', {
        messageId: message.id,
        conversationId: message.conversationId,
      });
      return;
    }
    // 记录已广播的 messageId（LRU 策略：满时清空最旧的一半）
    if (this.recentBroadcasts.size >= MessageBroadcaster.DEDUP_MAX_SIZE) {
      const half = Math.floor(MessageBroadcaster.DEDUP_MAX_SIZE / 2);
      const entries = this.recentBroadcasts.values();
      for (let i = 0; i < half; i++) {
        const entry = entries.next();
        if (!entry.done) this.recentBroadcasts.delete(entry.value);
      }
    }
    this.recentBroadcasts.add(message.id);

    // 1. 广播到 Web 端(通过 SSE 回调)
    this.broadcastToWeb(message);

    // 2. 广播到出站通道（飞书等；逐通道顺序 await，逐通道 catch 隔离——
    //    单通道失败不阻塞后续通道）
    for (const channel of this.messageChannels) {
      try {
        await channel.onMessage(message);
      } catch (err) {
        this.logger.error("Failed to dispatch message to outbound channel", err instanceof Error ? err : undefined, {
          conversationId: message.conversationId,
          messageId: message.id,
        });
      }
    }
  }

  /**
   * 广播 SSE 事件到 Web 端订阅者 + 出站事件通道
   * 用于 agent streaming 事件转发
   */
  broadcastEvent(conversationId: string, event: SSEEvent): void {
    // 出站事件通道（如飞书"正在思考..."，fire-and-forget）
    for (const channel of this.eventChannels) {
      try {
        channel.onEvent(conversationId, event);
      } catch (err) {
        this.logger.error("Failed to dispatch event to outbound channel", err instanceof Error ? err : undefined, {
          conversationId,
          event: event.event,
        });
      }
    }

    const subscribers = this.eventSubscribers.get(conversationId);
    if (!subscribers || subscribers.size === 0) {
      // F20260817bcst 三轮审视：web-only 修复后此路径新激活（此前 broadcaster undefined 短路），
      // scheduler/cron 触发的 invoke 无任何订阅者，每轮 10-60 事件全是此分支——降为 debug 防日志噪音
      this.logger.debug("[broadcastEvent] 无事件订阅者", { conversationId, event: event.event });
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
      this.logger.debug("[broadcastToWeb] 无订阅者,跳过", {
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
}
