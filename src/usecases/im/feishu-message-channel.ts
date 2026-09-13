import type { ManageConnection } from "./manage-connection";
import type { FeishuGateway } from "./feishu-gateway";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { USER_DISPLAY_NAME_KEY } from "@usecases/settings/settings-keys";
import type { Logger } from "@usecases/ports/logger";
import type { SSEEvent } from "@contract/sse/events";
import type { OutboundEventChannel } from "./message-broadcaster";
import { projectForChannel } from "@entities/conversation/message-body-projection";

/**
 * 飞书出站通道（issue #281，自 MessageBroadcaster 拆出）。
 *
 * 飞书信道适配(F20260812fmdr)，语义与拆出前一致：
 * - 最终消息: projectForChannel 投影 → replyMarkdown 走 post + md 富文本
 * - 思考中消息: message.start 事件触发 → replyText 发 `[otter名] 正在思考...`
 * - 降级: replyMarkdown 失败时由 client.ts 自动降级到 replyText 带 [纯文本降级] 前缀
 */
export class FeishuMessageChannel implements OutboundEventChannel {
  constructor(
    private readonly manageConnection: ManageConnection,
    private readonly feishuGateway: FeishuGateway,
    private readonly logger: Logger,
    /** Web 端 base URL,用于飞书侧 html-card 占位符拼接跳转链接 */
    private readonly webBaseUrl?: string,
    /** F20260828fsyc：可选注入。Web 消息出站标签显示全局名而非硬编码「用户」;
     *  未注入时保持原行为（回退「用户」） */
    private readonly settingsRepo?: Pick<SettingsRepository, "get">,
  ) {}


  /**
   * message.start 触发的飞书"正在思考..."临时消息(消除 IM 静默期)
   *
   * 时间戳 gate(审视 R5): 发送前检查距 message.start.createdAt 的延迟,
   * 超过阈值(3s)说明 IO 慢且 agent 可能已完成、最终消息可能已到达 —— 此时发
   * "正在思考..." 会晚于最终消息造成乱序,跳过。
   */
  /** F20260913ctlv 批4a：SSE 事件出站——invoke.start 触发"正在思考..."
   *  （message.start 已无生产者）；entry.speak = speak 气泡出站投递
   *  （替代已死的 onMessage/broadcaster.broadcast 链路）。
   *  F20260913ctlv 处置轮：entry.user = Web→飞书用户消息同步（F20260828fsyc 恢复）——
   *  防回环闸 source=web（IM 入站链的 entry.user 事件 source=feishu/weixin，不回投） */
  onEvent(conversationId: string, event: SSEEvent): void {
    if (event.event === "invoke.start") {
      this.maybeSendFeishuThinkingMessage(conversationId, event).catch((err) => {
        this.logger.error("Failed to send feishu thinking message", err instanceof Error ? err : undefined, {
          conversationId,
        });
      });
      return;
    }
    if (event.event === "entry.speak") {
      this.deliverSpeakToFeishu(conversationId, event).catch((err) => {
        this.logger.error("Failed to deliver speak entry to Feishu", err instanceof Error ? err : undefined, { conversationId });
      });
      return;
    }
    if (event.event === "entry.user") {
      this.deliverUserEntryToFeishu(conversationId, event).catch((err) => {
        this.logger.error("Failed to deliver user entry to Feishu", err instanceof Error ? err : undefined, { conversationId });
      });
    }
  }

  /** entry.speak 出站：speak body 投影 + markdown 投递（web 端发言之外唯一气泡来源） */
  private async deliverSpeakToFeishu(conversationId: string, event: SSEEvent): Promise<void> {
    const data = event.data as { body?: string; otterName?: string };
    if (!data.body) return;

    const session = await this.manageConnection.getSessionByConversation(conversationId);
    if (!session) return;
    const connection = await this.manageConnection.getConnection(session.connectionId);
    if (!connection) return;
    if (connection.externalType !== "feishu") return;

    const markdown = projectForChannel(data.body, {
      webBaseUrl: this.webBaseUrl,
      conversationId,
    });
    try {
      await this.feishuGateway.replyMarkdown(connection.externalId, data.otterName ?? "海獭", markdown);
    } catch (err) {
      this.logger.error("Failed to broadcast speak to Feishu (degradation also failed)", err instanceof Error ? err : undefined, { conversationId });
    }
  }

  /** entry.user 出站：Web 用户消息同步到飞书（F20260828fsyc 双向同步恢复）。
   *  防回环：仅投 source=web 的事件——IM 入站链（processor）广播的 entry.user
   *  source=feishu/weixin，直接跳过（消息已在 IM 侧，回投即复读）。 */
  private async deliverUserEntryToFeishu(conversationId: string, event: SSEEvent): Promise<void> {
    const data = event.data as { body?: string; source?: string };
    if (!data.body) return;
    if (data.source !== "web") return;

    const session = await this.manageConnection.getSessionByConversation(conversationId);
    if (!session) return;
    const connection = await this.manageConnection.getConnection(session.connectionId);
    if (!connection) return;
    if (connection.externalType !== "feishu") return;

    // Web 消息无渠道快照：显示全局名（本机即搭档本人），降级「用户」（与旧 resolveSenderLabel 语义一致）
    let senderLabel = "用户";
    try {
      const globalName = this.settingsRepo
        ? (await this.settingsRepo.get(USER_DISPLAY_NAME_KEY))?.trim()
        : undefined;
      if (globalName) senderLabel = globalName;
    } catch {
      // 标签解析异常不应吞掉整个投递（同步旧版防御语义）
    }

    const markdown = projectForChannel(data.body, {
      webBaseUrl: this.webBaseUrl,
      conversationId,
    });
    try {
      await this.feishuGateway.replyMarkdown(connection.externalId, senderLabel, markdown);
      this.logger.info("User entry synced to Feishu (web→feishu)", { conversationId });
    } catch (err) {
      this.logger.error("Failed to sync user entry to Feishu (degradation also failed)", err instanceof Error ? err : undefined, { conversationId });
    }
  }

  private async maybeSendFeishuThinkingMessage(conversationId: string, event: SSEEvent): Promise<void> {
    // invoke.start 数据面：otterName/startedAt（批4a 换轨）
    const data = event.data as { otterName?: string; startedAt?: string; createdAt?: string };
    const otterName = data.otterName;
    if (!otterName) return;

    // 时间戳 gate:startedAt 是 ISO string,转 ms 比对
    const THINKING_MESSAGE_MAX_DELAY_MS = 3000;
    const gateTs = data.startedAt ?? data.createdAt;
    if (gateTs) {
      const elapsedMs = Date.now() - new Date(gateTs).getTime();
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

    // F20260831xtrt 检视R1：onEvent（thinking）路径与 onMessage 对称路由——
    // 遗留微信连接曾因缺省建连被误投飞书（invalid receive_id 噪音），类型不对直接退出
    if (connection.externalType !== "feishu") {
      this.logger.debug("Skipping thinking message to non-feishu connection", {
        conversationId,
        externalType: connection.externalType,
      });
      return;
    }

    try {
      await this.feishuGateway.replyText(connection.externalId, `[${otterName}] 正在思考...`);
      this.logger.info("Feishu thinking message sent", { conversationId, otterName });
    } catch (err) {
      this.logger.error("Failed to send feishu thinking message", err instanceof Error ? err : undefined, {
        conversationId,
      });
    }
  }


}
