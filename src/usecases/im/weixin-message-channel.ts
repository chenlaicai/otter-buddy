import type { ManageConnection } from "./manage-connection";
import type { WeixinGateway } from "./weixin-gateway";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { USER_DISPLAY_NAME_KEY } from "@usecases/settings/settings-keys";
import type { Logger } from "@usecases/ports/logger";
import type { SSEEvent } from "@contract/sse/events";
import type { OutboundEventChannel } from "./message-broadcaster";
import { projectForChannel } from "@entities/conversation/message-body-projection";

/**
 * 微信出站通道（issue #565，照 FeishuMessageChannel 模式）。
 *
 * 微信与飞书的差异点：
 * - 协议只收纯文本（item type=1）→ markdown 投影后按 replyText 语义发送
 *   （projectForChannel 产出文本，html-card 落占位符 + Web 链接，同飞书）
 * - 会话模型是"人对 bot 私聊"：connection.externalId = 对端 ilink_user_id
 *   （出站目标），context_token 由 ingress 落盘、gateway 实现层查表回填
 */
export class WeixinMessageChannel implements OutboundEventChannel {
  // eslint-disable-next-line max-params -- 依赖由 DI 装配，参数数量由依赖决定（同 feishu-message-controller 约定）
  constructor(
    private readonly manageConnection: ManageConnection,
    private readonly weixinGateway: WeixinGateway,
    private readonly queryOtter: QueryOtter,
    private readonly logger: Logger,
    private readonly webBaseUrl?: string,
    private readonly settingsRepo?: Pick<SettingsRepository, "get">,
  ) {}



  /** F20260910ctlv 批4a：SSE 事件出站——invoke.start 触发"正在思考..."
   *  （与飞书同语义；message.start 已无生产者）；entry.speak = speak 气泡出站投递。
   *  F20260910ctlv 处置轮：entry.user = Web→微信用户消息同步（F20260828fsyc 同步链恢复）——
   *  防回环闸 source=web（微信入站链的 entry.user 事件 source=weixin，不回投） */
  onEvent(conversationId: string, event: SSEEvent): void {
    if (event.event === "invoke.start") {
      this.maybeSendThinkingMessage(conversationId, event).catch((err) => {
        this.logger.error("Failed to send Weixin thinking message", err instanceof Error ? err : undefined, {
          conversationId,
        });
      });
      return;
    }
    if (event.event === "entry.speak") {
      this.deliverSpeakToWeixin(conversationId, event).catch((err) => {
        this.logger.error("Failed to deliver speak entry to Weixin", err instanceof Error ? err : undefined, { conversationId });
      });
      return;
    }
    if (event.event === "entry.user") {
      this.deliverUserEntryToWeixin(conversationId, event).catch((err) => {
        this.logger.error("Failed to deliver user entry to Weixin", err instanceof Error ? err : undefined, { conversationId });
      });
    }
  }

  /** entry.user 出站：Web 用户消息同步到微信（防回环：仅投 source=web） */
  private async deliverUserEntryToWeixin(conversationId: string, event: SSEEvent): Promise<void> {
    const data = event.data as { body?: string; source?: string };
    if (!data.body) return;
    if (data.source !== "web") return;

    const session = await this.manageConnection.getSessionByConversation(conversationId);
    if (!session) return;
    const connection = await this.manageConnection.getConnection(session.connectionId);
    if (!connection) return;
    if (connection.externalType !== "weixin") return;

    // Web 消息无渠道快照：显示全局名，降级「用户」（与旧 resolveSenderLabel 语义一致）
    let senderLabel = "用户";
    try {
      const globalName = this.settingsRepo
        ? (await this.settingsRepo.get(USER_DISPLAY_NAME_KEY))?.trim()
        : undefined;
      if (globalName) senderLabel = globalName;
    } catch {
      // 标签解析异常不应吞掉整个投递
    }

    const projected = projectForChannel(data.body, {
      webBaseUrl: this.webBaseUrl,
      conversationId,
    });
    try {
      await this.weixinGateway.replyMarkdown(connection.externalId, senderLabel, projected);
      this.logger.info("User entry synced to Weixin (web→weixin)", { conversationId });
    } catch (err) {
      this.logger.error("Failed to sync user entry to Weixin", err instanceof Error ? err : undefined, { conversationId });
    }
  }

  /** entry.speak 出站：speak body 投影 + 纯文本投递（与飞书同构） */
  private async deliverSpeakToWeixin(conversationId: string, event: SSEEvent): Promise<void> {
    const data = event.data as { body?: string; otterName?: string };
    if (!data.body) return;

    const session = await this.manageConnection.getSessionByConversation(conversationId);
    if (!session) return;
    const connection = await this.manageConnection.getConnection(session.connectionId);
    if (!connection) return;
    if (connection.externalType !== "weixin") return;

    const projected = projectForChannel(data.body, {
      webBaseUrl: this.webBaseUrl,
      conversationId,
    });
    try {
      await this.weixinGateway.replyMarkdown(connection.externalId, data.otterName ?? "海獭", projected);
    } catch (err) {
      this.logger.error("Failed to broadcast speak to Weixin", err instanceof Error ? err : undefined, { conversationId });
    }
  }

  private async maybeSendThinkingMessage(conversationId: string, event: SSEEvent): Promise<void> {
    // 时间戳 gate（同飞书审视 R5 语义）：invoke.start 延迟超 3s 说明 IO 慢，
    // 最终发言可能已在路上——此时发"正在思考..."会乱序，跳过
    const d = event.data as { startedAt?: string; createdAt?: string } | undefined;
    const startedAt = d?.startedAt ?? d?.createdAt;
    if (startedAt && Date.now() - new Date(startedAt).getTime() > 3000) return;

    const session = await this.manageConnection.getSessionByConversation(conversationId);
    if (!session) return;
    const connection = await this.manageConnection.getConnection(session.connectionId);
    if (!connection) return;

    // F20260831xtrt 检视R1：onEvent（thinking）路径与 onMessage 对称路由，飞书会话不进本通道
    if (connection.externalType !== "weixin") {
      this.logger.debug("Skipping thinking message to non-weixin connection", {
        conversationId,
        externalType: connection.externalType,
      });
      return;
    }

    const otterName = await this.resolveOtterName(event);
    try {
      // F20260829wxch（#213 检视发现3）：thinking 可丢弃，无 context_token 时跳过不裸发
      await this.weixinGateway.replyText(connection.externalId, `${otterName} 正在思考...`, { requireContextToken: true });
    } catch (err) {
      this.logger.error("Failed to send Weixin thinking message", err instanceof Error ? err : undefined, {
        conversationId,
      });
    }
  }


  private async resolveOtterName(event: SSEEvent): Promise<string> {
    const otterId = (event.data as { otterId?: string } | undefined)?.otterId;
    if (otterId) {
      const otter = await this.queryOtter.getById(otterId).catch(() => undefined);
      if (otter?.name) return otter.name;
    }
    return "海獭";
  }

}
