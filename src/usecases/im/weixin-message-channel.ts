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
 * - 会话模型是"人对 bot 私聊"：connection.externalId = bot 账号 id（F20260921wxba
 *   路由锚），出站收信人经 manageConnection.resolveReplyTarget 从
 *   metadata.lastChatId 取回（ilinkUserId，入站由 processor 记录，F20260922wxeg）；
 *   context_token 由 ingress 落盘、gateway 实现层查表回填
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



  /** F20260913ctlv 批4a：SSE 事件出站——invoke.start 触发"正在思考..."
   *  （与飞书同语义；message.start 已无生产者）；entry.speak = speak 气泡出站投递。
   *  F20260913ctlv 处置轮：entry.user = Web→微信用户消息同步（F20260828fsyc 同步链恢复）——
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
      return;
    }
    // F20260920imax：invoke 失败兑底——不再静默（现场：kimi 配额 403 后用户只看到
    // 「正在思考...」再无下文）。微信侧发失败提示，用户知道重试而非干等
    if (event.event === "entry.failed") {
      this.deliverFailureNotice(conversationId, event).catch((err) => {
        this.logger.error("Failed to deliver failure notice to Weixin", err instanceof Error ? err : undefined, { conversationId });
      });
    }
  }

  /** F20260922wxeg：出站目标解析——connection.externalId 是 bot 账号 id（路由锚），
   *  收信人经 resolveReplyTarget 从 metadata.lastChatId 取回（ilinkUserId，入站时
   *  由 message-processor 记录）。解析不到目标 = 用户尚未在新 connection 上说过话
   *  ——跳过发送记 warn（发给 bot 账号 id 只会 ret=-3 假失败，绝不投递） */
  private resolveTarget(connectionId: string, connection: { externalId: string; externalType: string; metadata?: Record<string, unknown> | null }): string | null {
    const target = this.manageConnection.resolveReplyTarget(connection as never);
    if (!target) {
      this.logger.warn("Weixin outbound skipped: no reply target yet（等用户先发一条消息建立出站锚）", { connectionId });
    }
    return target;
  }

  /** F20260920imax：invoke 终态失败 → 微信侧提示（思考中后无下文的静默兑底） */
  private async deliverFailureNotice(conversationId: string, _event: SSEEvent): Promise<void> {
    const session = await this.manageConnection.getSessionByConversation(conversationId);
    if (!session) return;
    const connection = await this.manageConnection.getConnection(session.connectionId);
    if (!connection) return;
    if (connection.externalType !== "weixin") return;
    const target = this.resolveTarget(connection.id, connection);
    if (!target) return;

    try {
      await this.weixinGateway.replyText(target, "⚠️ 助理这会儿没能回复（服务端处理失败）。稍后再发一条试试，若持续失败请到 Web 端查看详情 🦦");
    } catch (err) {
      this.logger.error("Weixin failure notice send failed", err instanceof Error ? err : undefined, { conversationId });
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
    const target = this.resolveTarget(connection.id, connection);
    if (!target) return;

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
      await this.weixinGateway.replyMarkdown(target, senderLabel, projected);
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
    const target = this.resolveTarget(connection.id, connection);
    if (!target) return;

    const projected = projectForChannel(data.body, {
      webBaseUrl: this.webBaseUrl,
      conversationId,
    });
    try {
      await this.weixinGateway.replyMarkdown(target, data.otterName ?? "海獭", projected);
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
    const target = this.resolveTarget(connection.id, connection);
    if (!target) return;
    try {
      // F20260829wxch（#213 检视发现3）：thinking 可丢弃，无 context_token 时跳过不裸发
      await this.weixinGateway.replyText(target, `${otterName} 正在思考...`, { requireContextToken: true });
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
