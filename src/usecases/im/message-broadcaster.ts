import type { Logger } from "@usecases/ports/logger";
import type { SSEEvent } from "@contract/sse/events";

/**
 * 进程内事件广播总线（issue #281；F20260913ctlv 处置轮收缩）。
 *
 * 职责：Web SSE 订阅者的事件分发（entry.* / invoke.*）+ 出站事件通道（IM）的注册与转发。
 * **平台无关**：bootstrap 无条件创建；飞书/微信出站（markdown 投递 / "正在思考..." /
 * Web→IM 用户消息同步）在各 MessageChannel，作为 outbound channel 在对应平台启用时注册。
 *
 * F20260913ctlv：消息级广播面（broadcast/onMessage/三参 subscribe）随 messages 停写
 * 全部退役——出站走事件通道（channel.onEvent 消费 entry.user/entry.speak/invoke.start）。
 */
export interface OutboundEventChannel {
  /** streaming 事件出站（fire-and-forget，如飞书"正在思考..."、Web→IM 用户消息同步） */
  onEvent(conversationId: string, event: SSEEvent): void;
}

export class MessageBroadcaster {
  // Web 端的事件订阅者(conversationId -> Set<callback>),用于转发 agent streaming 事件
  private eventSubscribers = new Map<string, Set<(event: SSEEvent) => void>>();
  // 出站事件通道（飞书等外部 IM；按注册序调用）。#591：key = 通道唯一标识
  // （"feishu" / "weixin-<accountId>"）——同 key 重复注册**替换**旧通道而非追加，
  // 防止微信热启动重登录后旧通道残留导致一条消息多次投递；unregister 供
  // 停轮询/删账号时成对清理（Map 保插入序，替换不改变广播顺序）
  private outboundChannels = new Map<string, OutboundEventChannel>();

  constructor(private readonly logger: Logger) {}

  /** 注册出站事件通道（bootstrap 在对应平台启用时调用）。同 key 再注册 = 替换（#591 替换语义） */
  registerOutboundChannel(key: string, channel: OutboundEventChannel): void {
    this.outboundChannels.set(key, channel);
  }

  /** 注销出站通道（账号删除/同 key 替换停旧通道时调用，#591）；未注册返回 false */
  unregisterOutboundChannel(key: string): boolean {
    return this.outboundChannels.delete(key);
  }

  /**
   * Web 端订阅消息和事件
   * 返回取消订阅函数(同时清理消息和事件订阅)
   */
  /** F20260913ctlv 批4a：纯事件订阅（entry 与 invoke 事件；消息回调链路已删） */
  subscribeEvents(conversationId: string, onEvent: (event: SSEEvent) => void): () => void {
    if (!this.eventSubscribers.has(conversationId)) {
      this.eventSubscribers.set(conversationId, new Set());
    }
    this.eventSubscribers.get(conversationId)!.add(onEvent);
    this.logger.info("Event subscriber added", {
      conversationId,
      subscriberCount: this.eventSubscribers.get(conversationId)!.size,
    });
    return () => {
      this.eventSubscribers.get(conversationId)?.delete(onEvent);
      if (this.eventSubscribers.get(conversationId)?.size === 0) {
        this.eventSubscribers.delete(conversationId);
      }
    };
  }

  /**
   * 广播 SSE 事件到 Web 端订阅者 + 出站事件通道
   * 用于 agent streaming 事件转发
   */
  broadcastEvent(conversationId: string, event: SSEEvent): void {
    // 出站事件通道（如飞书"正在思考..."，fire-and-forget）
    for (const [key, channel] of this.outboundChannels) {
      try {
        channel.onEvent(conversationId, event);
      } catch (err) {
        this.logger.error("Failed to dispatch event to outbound channel", err instanceof Error ? err : undefined, {
          conversationId,
          event: event.event,
          channelKey: key,
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

}
