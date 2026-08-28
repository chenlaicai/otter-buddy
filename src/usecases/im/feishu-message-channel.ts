import type { Message } from "@entities/conversation/message";
import { aggregateBody } from "@entities/conversation/message";
import type { ManageConnection } from "./manage-connection";
import type { FeishuGateway } from "./feishu-gateway";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { USER_DISPLAY_NAME_KEY } from "@usecases/settings/settings-keys";
import type { Logger } from "@usecases/ports/logger";
import type { SSEEvent } from "@contract/sse/events";
import type { OutboundMessageChannel, OutboundEventChannel } from "./message-broadcaster";
import { projectForChannel } from "@entities/conversation/message-body-projection";

/**
 * 飞书出站通道（issue #281，自 MessageBroadcaster 拆出）。
 *
 * 飞书信道适配(F20260812fmdr)，语义与拆出前一致：
 * - 最终消息: projectForChannel 投影 → replyMarkdown 走 post + md 富文本
 * - 思考中消息: message.start 事件触发 → replyText 发 `[otter名] 正在思考...`
 * - 降级: replyMarkdown 失败时由 client.ts 自动降级到 replyText 带 [纯文本降级] 前缀
 */
export class FeishuMessageChannel implements OutboundMessageChannel, OutboundEventChannel {
  // eslint-disable-next-line max-params -- 依赖由 DI 装配，参数数量由依赖决定（同 message-controller 约定）
  constructor(
    private readonly manageConnection: ManageConnection,
    private readonly feishuGateway: FeishuGateway,
    private readonly queryOtter: QueryOtter,
    private readonly logger: Logger,
    /** Web 端 base URL,用于飞书侧 html-card 占位符拼接跳转链接 */
    private readonly webBaseUrl?: string,
    /** F20260828fsyc：可选注入。Web 消息出站标签显示全局名而非硬编码「用户」;
     *  未注入时保持原行为（回退「用户」） */
    private readonly settingsRepo?: Pick<SettingsRepository, "get">,
  ) {}

  /** broadcast 出站：投影 + markdown 投递到绑定的飞书会话 */
  async onMessage(message: Message): Promise<void> {
    if (!this.shouldBroadcastToFeishu(message)) return;

    const session = await this.manageConnection.getSessionByConversation(message.conversationId);
    if (!session) return;

    const connection = await this.manageConnection.getConnection(session.connectionId);
    if (!connection) return;

    const senderLabel = await this.resolveSenderLabel(message);
    const body = aggregateBody(message.segments) || "(空消息)";
    // 多模态 Phase 1：附件投影进 projectForChannel 流水线（truncate 前注入，跨通道不丢）。
    // 广播链路传 entities Message，attachments 由 repository 加载回填（组装点①）。
    const markdown = projectForChannel(body, {
      webBaseUrl: this.webBaseUrl,
      conversationId: message.conversationId,
      attachments: message.attachments,
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
  onEvent(conversationId: string, event: SSEEvent): void {
    if (event.event !== "message.start") return;
    this.maybeSendFeishuThinkingMessage(conversationId, event).catch((err) => {
      this.logger.error("Failed to send feishu thinking message", err instanceof Error ? err : undefined, {
        conversationId,
      });
    });
  }

  private async maybeSendFeishuThinkingMessage(conversationId: string, event: SSEEvent): Promise<void> {
    const data = event.data as { otterName?: string; createdAt?: string };
    const otterName = data.otterName;
    if (!otterName) return;

    // 时间戳 gate:createdAt 是 ISO string,转 ms 比对
    const THINKING_MESSAGE_MAX_DELAY_MS = 3000;
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

  /** 解析发送者显示标签(用于飞书 post title)
   *  F20260828fsyc：user 消息显示搭档全局名而非硬编码「用户」（与 Web 端渲染语义对齐）。
   *  注：防回环（shouldBroadcastToFeishu）保证走到这里的 user 消息只来自 Web——
   *  source=feishu 在入口已拦截，故无需渠逈分叉；快照优先分支是防御性保留
   *  （未来若开跨群转发，飞书快照名可直接生效） */
  private async resolveSenderLabel(message: Message): Promise<string> {
    if (message.senderType === "user") {
      const snapshot = message.senderName?.trim();
      if (snapshot) return snapshot;
      // Web 消息无快照：显示全局名（本机即搭档本人,PartnerResolver.isPartner('user') 恒真）。
      // 审视修复 R1：settings 读取失败时降级回「用户」——标签解析异常不应吞掉整个广播
      // （旧实现「用户」是同步硬编码永不失败，本调用是异步 DB 读，防御语义对齐旧版）
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
