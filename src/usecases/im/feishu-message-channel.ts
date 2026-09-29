import type { ManageConnection } from "./manage-connection";
import type { FeishuGateway } from "./feishu-gateway";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { USER_DISPLAY_NAME_KEY } from "@usecases/settings/settings-keys";
import type { Logger } from "@usecases/ports/logger";
import type { SSEEvent } from "@contract/sse/events";
import type { OutboundEventChannel } from "./message-broadcaster";
import type { AttachmentRef } from "@entities/conversation/attachment";
import type { AttachmentRepository } from "@usecases/conversation/attachment-repository";
import type { SendEntry } from "@usecases/conversation/send-entry";
import { projectForChannel } from "@entities/conversation/message-body-projection";
import path from "node:path";

/**
 * 飞书出站通道（issue #281，自 MessageBroadcaster 拆出）。
 *
 * 飞书信道适配(F20260812fmdr)，语义与拆出前一致：
 * - 最终消息: projectForChannel 投影 → replyMarkdown 走 post + md 富文本
 * - 思考中消息: message.start 事件触发 → replyText 发 `[otter名] 正在思考...`
 * - 降级: replyMarkdown 失败时由 client.ts 自动降级到 replyText 带 [纯文本降级] 前缀
 */
export class FeishuMessageChannel implements OutboundEventChannel {
  constructor(private readonly o: {
    manageConnection: ManageConnection;
    feishuGateway: FeishuGateway;
    logger: Logger;
    /** Web 端 base URL,用于飞书侧 html-card 占位符拼接跳转链接 */
    webBaseUrl?: string;
    /** F20260828fsyc：可选注入。Web 消息出站标签显示全局名而非硬编码「用户」;
     *  未注入时保持原行为（回退「用户」） */
    settingsRepo?: Pick<SettingsRepository, "get">;
    /** F20260928fsqr：可选注入。键控出站（#591 同构）——多 app 并行时每条 WS 注册
     *  一个通道，本通道只投 externalId === botKey 的连接；缺省 undefined = 全飞书连接
     *  （存量单 app 零参兼容，行为不变） */
    botKey?: string;
    /** #902 媒体出站恢复：可选注入。附件实体查询（拿 filePath 供媒体上传）+ speak entry
     *  附件补拉（事件载荷缺 attachments 时按 entryId 回查）；未注入时降级纯占位投影不阻塞。
     *  storageRoot 用于把 entity.filePath（相对路径）解析成绝对路径 */
    attachmentDeps?: {
      attachmentRepo: Pick<AttachmentRepository, "getByIds">;
      entryReader: Pick<SendEntry, "getEntryById">;
      storageRoot: string;
    };
  }) {}

  /** F20260928fsqr：归属判定——本通道只投递 externalId === 本通道 botKey 的连接。
   *  botKey 未注入（存量单 app）时退化为仅类型判定（原行为）。 */
  private ownsConnection(connection: { externalType: string; externalId: string }): boolean {
    if (connection.externalType !== "feishu") return false;
    if (this.o.botKey === undefined) return true;
    return connection.externalId === this.o.botKey;
  }


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
        this.o.logger.error("Failed to send feishu thinking message", err instanceof Error ? err : undefined, {
          conversationId,
        });
      });
      return;
    }
    if (event.event === "entry.speak") {
      this.deliverSpeakToFeishu(conversationId, event).catch((err) => {
        this.o.logger.error("Failed to deliver speak entry to Feishu", err instanceof Error ? err : undefined, { conversationId });
      });
      return;
    }
    if (event.event === "entry.user") {
      this.deliverUserEntryToFeishu(conversationId, event).catch((err) => {
        this.o.logger.error("Failed to deliver user entry to Feishu", err instanceof Error ? err : undefined, { conversationId });
      });
      return;
    }
    // F20260920imax：invoke 失败兑底——与微信同语义，不再静默
    if (event.event === "entry.failed") {
      this.deliverFailureNotice(conversationId).catch((err) => {
        this.o.logger.error("Failed to deliver failure notice to Feishu", err instanceof Error ? err : undefined, { conversationId });
      });
    }
  }

  /** F20260920imax：invoke 终态失败 → 飞书侧提示（思考中后无下文的静默兑底） */
  private async deliverFailureNotice(conversationId: string): Promise<void> {
    const session = await this.o.manageConnection.getSessionByConversation(conversationId);
    if (!session) return;
    const connection = await this.o.manageConnection.getConnection(session.connectionId);
    if (!connection) return;
    if (!this.ownsConnection(connection)) return;

    try {
      const failTarget = this.o.manageConnection.resolveReplyTarget(connection);
      if (failTarget) await this.o.feishuGateway.replyText(failTarget, "⚠️ 助理这会儿没能回复（服务端处理失败）。稍后再发一条试试，若持续失败请到 Web 端查看详情 🦦");
    } catch (err) {
      this.o.logger.error("Feishu failure notice send failed", err instanceof Error ? err : undefined, { conversationId });
    }
  }

  /** entry.speak 出站：speak body 投影 + markdown 投递（web 端发言之外唯一气泡来源）。
   *  #902 媒体出站：事件载荷无 attachments 时按 entryId 补拉（speak 工具暂无附件写入源，
   *  写入源就绪前事件恒缺席——补拉是 speak 侧唯一取附件路径）；拉到则投影占位 + 图片真实投递 */
  private async deliverSpeakToFeishu(conversationId: string, event: SSEEvent): Promise<void> {
    const data = event.data as { body?: string; otterName?: string; attachments?: AttachmentRef[]; entryId?: string };
    if (!data.body) return;

    const session = await this.o.manageConnection.getSessionByConversation(conversationId);
    if (!session) return;
    const connection = await this.o.manageConnection.getConnection(session.connectionId);
    if (!connection) return;
    if (!this.ownsConnection(connection)) return;
    // F20260920imax 增量五：bot connection 的 externalId 是 bot 键非 chatId——
    // 经 resolveReplyTarget 从 metadata.lastChatId 定向（普通连接直用 externalId）
    const replyTarget = this.o.manageConnection.resolveReplyTarget(connection);
    if (!replyTarget) return;

    // #902：附件补拉（事件载荷缺席时）——拉不到降级纯文本，不阻塞
    const attachments = await this.resolveAttachments(data);

    const markdown = projectForChannel(data.body, {
      webBaseUrl: this.o.webBaseUrl,
      conversationId,
      ...(attachments.length > 0 && { attachments }),
    });
    try {
      await this.o.feishuGateway.replyMarkdown(replyTarget, data.otterName ?? "海獭", markdown);
    } catch (err) {
      this.o.logger.error("Failed to broadcast speak to Feishu (degradation also failed)", err instanceof Error ? err : undefined, { conversationId });
    }
    // r1-S1：媒体投递独立于文本 try——文本失败（含降级链尽）时媒体仍发，
    // per-item 失败在 sendImageAttachments 内部处理，不向上抛
    await this.sendImageAttachments(replyTarget, attachments);
  }

  /** entry.user 出站：Web 用户消息同步到飞书（F20260828fsyc 双向同步恢复）。
   *  防回环：仅投 source=web 的事件——IM 入站链（processor）广播的 entry.user
   *  source=feishu/weixin，直接跳过（消息已在 IM 侧，回投即复读）。
   *  #902 媒体出站：事件自带 attachments（发射点已投影）直接消费 + 图片真实投递 */
  private async deliverUserEntryToFeishu(conversationId: string, event: SSEEvent): Promise<void> {
    const data = event.data as { body?: string; source?: string; attachments?: AttachmentRef[] };
    if (!data.body) return;
    if (data.source !== "web") return;

    const session = await this.o.manageConnection.getSessionByConversation(conversationId);
    if (!session) return;
    const connection = await this.o.manageConnection.getConnection(session.connectionId);
    if (!connection) return;
    if (!this.ownsConnection(connection)) return;

    const senderLabel = await this.resolveSenderLabel();

    // #902：entry.user 事件自带 attachments（发射点已投影），直接消费；缺席时降级纯文本
    const attachments = data.attachments ?? [];

    const markdown = projectForChannel(data.body, {
      webBaseUrl: this.o.webBaseUrl,
      conversationId,
      ...(attachments.length > 0 && { attachments }),
    });
    try {
      await this.deliverMarkdownToTarget(connection, senderLabel, markdown, conversationId, "User entry synced to Feishu (web→feishu)");
    } catch (err) {
      this.o.logger.error("Failed to sync user entry to Feishu (degradation also failed)", err instanceof Error ? err : undefined, { conversationId });
    }
    // r1-S1：媒体投递独立于文本 try——文本失败时媒体仍发（同 speak 路径）
    await this.sendImageAttachments(this.resolveReplyTargetSafe(connection), attachments);
  }

  /** Web 消息发送者标签：全局名（本机即搭档本人），降级「用户」（与旧 resolveSenderLabel 语义一致）。
   *  #902 拆出（complexity 超限）：标签解析异常不吞掉整个投递（同步旧版防御语义） */
  private async resolveSenderLabel(): Promise<string> {
    try {
      const globalName = this.o.settingsRepo
        ? (await this.o.settingsRepo.get(USER_DISPLAY_NAME_KEY))?.trim()
        : undefined;
      return globalName || "用户";
    } catch {
      return "用户";
    }
  }

  /** F20260920imax 增量五：出站定向投递（bot connection 从 metadata.lastChatId 解析，
   *  空目标静默跳过）——拆出降 deliverUserEntryToFeishu 复杂度 */
  private async deliverMarkdownToTarget(connection: { externalId: string; externalType: string }, senderLabel: string, markdown: string, conversationId: string, successLogMsg: string): Promise<void> {
    const target = this.o.manageConnection.resolveReplyTarget(connection as never);
    if (!target) return;
    await this.o.feishuGateway.replyMarkdown(target, senderLabel, markdown);
    this.o.logger.info(successLogMsg, { conversationId });
  }

  /** #902：resolveReplyTarget 的非断言包装（deliverUserEntryToFeishu 内已过类型闸，
   *  但 media 投递需独立取 target——复用同一解析口避免二次解析逻辑分叉） */
  private resolveReplyTargetSafe(connection: { externalId: string; externalType: string }): string | null {
    try {
      return this.o.manageConnection.resolveReplyTarget(connection as never) ?? null;
    } catch {
      return null;
    }
  }

  /** #902：附件解析——事件载荷自带 attachments（entry.user 发射点已投影）直接用；
   *  载荷缺席（entry.speak 现阶段恒缺席）时按 entryId 补拉 entry 读出链（自带投影）。
   *  补拉失败/未注入附件依赖时返回空数组降级纯文本，不阻塞文本投递 */
  private async resolveAttachments(data: { attachments?: AttachmentRef[]; entryId?: string }): Promise<AttachmentRef[]> {
    if (data.attachments && data.attachments.length > 0) return data.attachments;
    if (!data.entryId || !this.o.attachmentDeps) return [];
    try {
      const entry = await this.o.attachmentDeps.entryReader.getEntryById(data.entryId);
      return entry?.attachments ?? [];
    } catch (err) {
      this.o.logger.warn("Feishu attachment backfill failed, degrading to text-only", {
        entryId: data.entryId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** #902：图片真实投递（飞书仅 image 分支——document/audio/video 无上传通道，
   *  占位投影已在 projectForChannel 产出的 markdown 里兑底）。
   *  逐张上传发送；单项失败不阻塞其余（占位已在文本里可见）
   *  附件依赖未注入时静默跳过（占位投影仍生效，语义与旧 sendAttachments 先例一致） */
  private async sendImageAttachments(replyTarget: string | null, attachments: AttachmentRef[]): Promise<void> {
    if (!replyTarget || attachments.length === 0) return;
    const images = attachments.filter(a => a.kind === "image");
    if (images.length === 0) return;
    if (!this.o.attachmentDeps) {
      this.o.logger.debug("Feishu image send skipped: attachment deps not injected");
      return;
    }
    for (const img of images) {
      try {
        const [entity] = await this.o.attachmentDeps.attachmentRepo.getByIds([img.id]);
        if (!entity) {
          this.o.logger.warn("Feishu attachment not found, skip", { attachmentId: img.id });
          continue;
        }
        // filePath 是相对 storageRoot 的路径（内容寻址分桶），解析成绝对路径再交给 gateway
        const absPath = path.join(this.o.attachmentDeps.storageRoot, entity.filePath);
        await this.o.feishuGateway.replyImage(replyTarget, { filePath: absPath, fileName: img.originalName, mimeType: img.mimeType });
      } catch (err) {
        this.o.logger.error("Feishu image send failed, placeholder remains in text", err instanceof Error ? err : undefined, {
          attachmentId: img.id,
          fileName: img.originalName,
        });
      }
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
        this.o.logger.info("Skip feishu thinking message: too slow, final message likely already sent", {
          conversationId,
          otterName,
          elapsedMs,
        });
        return;
      }
    }

    const session = await this.o.manageConnection.getSessionByConversation(conversationId);
    if (!session) return;
    const connection = await this.o.manageConnection.getConnection(session.connectionId);
    if (!connection) return;

    // F20260831xtrt 检视R1：onEvent（thinking）路径与 onMessage 对称路由——
    // 遗留微信连接曾因缺省建连被误投飞书（invalid receive_id 噪音），类型不对直接退出
    // F20260928fsqr：加 botKey 归属（多 app 时 thinking 也只进本通道的线）
    if (!this.ownsConnection(connection)) {
      this.o.logger.debug("Skipping thinking message to non-feishu/foreign-bot connection", {
        conversationId,
        externalType: connection.externalType,
      });
      return;
    }

    try {
      const thinkTarget = this.o.manageConnection.resolveReplyTarget(connection);
      if (thinkTarget) await this.o.feishuGateway.replyText(thinkTarget, `[${otterName}] 正在思考...`);
      this.o.logger.info("Feishu thinking message sent", { conversationId, otterName });
    } catch (err) {
      this.o.logger.error("Failed to send feishu thinking message", err instanceof Error ? err : undefined, {
        conversationId,
      });
    }
  }


}
