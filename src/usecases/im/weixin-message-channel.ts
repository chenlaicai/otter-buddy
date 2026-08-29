import type { Message } from "@entities/conversation/message";
import { aggregateBody } from "@entities/conversation/message";
import type { ManageConnection } from "./manage-connection";
import type { WeixinGateway } from "./weixin-gateway";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { USER_DISPLAY_NAME_KEY } from "@usecases/settings/settings-keys";
import type { Logger } from "@usecases/ports/logger";
import type { SSEEvent } from "@contract/sse/events";
import type { OutboundMessageChannel, OutboundEventChannel } from "./message-broadcaster";
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
export class WeixinMessageChannel implements OutboundMessageChannel, OutboundEventChannel {
  // eslint-disable-next-line max-params -- 依赖由 DI 装配，参数数量由依赖决定（同 feishu-message-controller 约定）
  constructor(
    private readonly manageConnection: ManageConnection,
    private readonly weixinGateway: WeixinGateway,
    private readonly queryOtter: QueryOtter,
    private readonly logger: Logger,
    private readonly webBaseUrl?: string,
    private readonly settingsRepo?: Pick<SettingsRepository, "get">,
  ) {}

  /** broadcast 出站：投影 + 纯文本投递到绑定的微信会话 */
  async onMessage(message: Message): Promise<void> {
    if (!this.shouldBroadcastToWeixin(message)) return;

    const session = await this.manageConnection.getSessionByConversation(message.conversationId);
    if (!session) return;

    const connection = await this.manageConnection.getConnection(session.connectionId);
    if (!connection) return;

    const senderLabel = await this.resolveSenderLabel(message);
    const body = aggregateBody(message.segments) || "(空消息)";
    const projected = projectForChannel(body, {
      webBaseUrl: this.webBaseUrl,
      conversationId: message.conversationId,
      attachments: message.attachments,
    });

    try {
      await this.weixinGateway.replyMarkdown(connection.externalId, senderLabel, projected);
      this.logger.info("Text message broadcast to Weixin", {
        conversationId: message.conversationId,
        messageId: message.id,
        toUserId: connection.externalId,
      });
    } catch (err) {
      this.logger.error("Failed to broadcast to Weixin", err instanceof Error ? err : undefined, {
        conversationId: message.conversationId,
        messageId: message.id,
      });
    }
  }

  /** message.start 触发"正在思考..."（与飞书同语义：消除 IM 静默期） */
  onEvent(conversationId: string, event: SSEEvent): void {
    if (event.event !== "message.start") return;
    this.maybeSendThinkingMessage(conversationId, event).catch((err) => {
      this.logger.error("Failed to send Weixin thinking message", err instanceof Error ? err : undefined, {
        conversationId,
      });
    });
  }

  private async maybeSendThinkingMessage(conversationId: string, event: SSEEvent): Promise<void> {
    // 时间戳 gate（同飞书审视 R5 语义）：message.start 延迟超 3s 说明 IO 慢，
    // 最终消息可能已在路上——此时发"正在思考..."会乱序，跳过
    const startedAt = (event.data as { createdAt?: string } | undefined)?.createdAt;
    if (startedAt && Date.now() - new Date(startedAt).getTime() > 3000) return;

    const session = await this.manageConnection.getSessionByConversation(conversationId);
    if (!session) return;
    const connection = await this.manageConnection.getConnection(session.connectionId);
    if (!connection) return;

    const otterName = await this.resolveOtterName(event);
    try {
      await this.weixinGateway.replyText(connection.externalId, `${otterName} 正在思考...`);
    } catch (err) {
      this.logger.error("Failed to send Weixin thinking message", err instanceof Error ? err : undefined, {
        conversationId,
      });
    }
  }

  private shouldBroadcastToWeixin(message: Message): boolean {
    // 只广播 agent 完成消息；user 消息不入站回声（微信侧用户自己看得见）
    if (message.senderType !== "otter") return false;
    // 微信 ingress 自己投递的消息不再回投（防回环）
    if (message.source === "weixin") return false;
    return true;
  }

  private async resolveOtterName(event: SSEEvent): Promise<string> {
    const otterId = (event.data as { otterId?: string } | undefined)?.otterId;
    if (otterId) {
      const otter = await this.queryOtter.getById(otterId).catch(() => undefined);
      if (otter?.name) return otter.name;
    }
    return "海獭";
  }

  private async resolveSenderLabel(message: Message): Promise<string> {
    // 快照优先：入站消息带来的 senderName 快照（与 Web 端渲染语义对齐）
    if (message.senderType === "user") {
      const snapshot = message.senderName?.trim();
      if (snapshot) return snapshot;
      try {
        const globalName = this.settingsRepo
          ? (await this.settingsRepo.get(USER_DISPLAY_NAME_KEY))?.trim()
          : undefined;
        return globalName || "用户";
      } catch (err) {
        this.logger.warn("Failed to read global display name, fall back to default label", {
          messageId: message.id,
          conversationId: message.conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
        return "用户";
      }
    }
    if (message.senderType === "otter") {
      const otter = await this.queryOtter.getById(message.senderId).catch(() => undefined);
      return otter?.name ?? message.senderId;
    }
    return "系统";
  }
}
