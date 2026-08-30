import type { ManageConnection } from "@usecases/im/manage-connection";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { WeixinGateway } from "@usecases/im/weixin-gateway";
import type { WeixinMediaGateway, WeixinMediaGatewayItem } from "@usecases/im/weixin-media-gateway";
import type { PartnerResolver } from "@usecases/im/partner-resolver";
import type { AgentDispatchService } from "@usecases/conversation/agent-dispatch-service";
import type { AttachmentUploadService } from "@usecases/conversation/attachment-upload-service";
import type { AttachmentInjectionService } from "@usecases/conversation/attachment-injection-service";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { Logger } from "@usecases/ports/logger";
import { Readable } from "node:stream";
import { parseCommand, formatConversationList, formatMessageHistory, HELP_TEXT } from "@usecases/im/feishu-command-parser";

/** 媒体项类型枚举镜像（协议固定值，port 层不引 frameworks） */
const WeixinItemTypes = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;

/** 命令处理结果：回复文本（各命令产出，统一由外层回发） */
type CommandReply = string;

/** 媒体处理结果：附件 id + 降级提示（照 FeishuAttachmentOutcome 语义） */
interface WeixinMediaOutcome {
  attachmentIds: string[];
  degradeNote: string | null;
  injection?: Awaited<ReturnType<AttachmentInjectionService["buildInjectionPayload"]>>;
}

/** 单个入站媒体项（从 item_list 提取；item 为结构兼容协议投影） */
interface WeixinMediaItemEntry {
  kind: "image" | "voice" | "file" | "video";
  item: WeixinMediaGatewayItem;
}

/**
 * 微信入站消息处理器（interface-adapters 层，照 FeishuMessageProcessor 模式）。
 *
 * 命令体系复用 feishu-command-parser（/list /in /out /history /help 与
 * ManageConnection 的会话绑定语义通道无关）；partnerResolver 做命令门禁
 * （F20260826fpbd 方案 B 同语义：配置 partnerUserId 时仅搭档可用命令）。
 */
export class WeixinMessageProcessor {
  constructor(
    private readonly deps: {
      manageConnection: ManageConnection;
      sendMessage: SendMessage;
      queryMessage: QueryMessage;
      weixinGateway: WeixinGateway;
      partnerResolver?: PartnerResolver;
      agentDispatchService: AgentDispatchService;
      messageBroadcaster: MessageBroadcaster;
      logger: Logger;
      /** 媒体支持（issue #567）：媒体下载网关 + 附件上传管线 + 注入服务。未注入时媒体降级为提示文本 */
      mediaGateway?: WeixinMediaGateway;
      attachmentUpload?: AttachmentUploadService;
      attachmentInjection?: AttachmentInjectionService;
    },
  ) {}

  async process(msg: { fromUserId: string; body: string; messageId?: string; raw?: { item_list?: WeixinMediaGatewayItem[] } }): Promise<void> {
    const { fromUserId, body } = msg;

    this.deps.logger.info("Processing Weixin message", {
      fromUserId,
      messageId: msg.messageId,
      textLength: body.length,
    });

    const connection = await this.deps.manageConnection.ensureConnection(fromUserId, fromUserId);

    if (!(await this.handleInbound(fromUserId, connection.id, msg))) return;
  }

  /** 入站主链：命令 → 会话检查 → 媒体 → 入库 → 广播 → dispatch（复杂度拆出） */
  private async handleInbound(fromUserId: string, connectionId: string, msg: { body: string; raw?: { item_list?: WeixinMediaGatewayItem[] } }): Promise<boolean> {
    const body = msg.body;

    // 命令分支（与飞书同门禁语义：未配置 partnerUserId 不拦，配置后仅搭档可用）
    if (body.startsWith("/")) {
      await this.dispatchCommand(fromUserId, connectionId, body);
      return false;
    }

    const conversation = await this.deps.manageConnection.getCurrentConversation(connectionId);
    if (!conversation) {
      await this.replyNoConversation(fromUserId, msg.raw?.item_list ?? []);
      return false;
    }

    // 媒体消息（issue #567）：本期仅图片入库（检视发现 2 收敛）；语音转写已在 body，
    // 文件/视频降级为可见提示（kind 扩展见 issue #604）
    const outcome = await this.composeMediaOutcome(msg.raw?.item_list ?? [], fromUserId);

    let bodyText = body.trim();
    if (outcome.degradeNote) bodyText = bodyText ? `${bodyText}\n${outcome.degradeNote}` : outcome.degradeNote;
    if (outcome.attachmentIds.length === 0 && !bodyText.trim()) bodyText = "[媒体消息处理失败]";

    const { message } = await this.deps.sendMessage.send({
      conversationId: conversation.id,
      senderId: fromUserId,
      senderType: "user",
      talkingStonePassedTo: [],
      body: bodyText,
      source: "weixin",
      ...(outcome.attachmentIds.length > 0 ? { attachmentIds: outcome.attachmentIds } : {}),
    });

    // 广播到 Web 端（实时同步；微信侧发送者自己可见，无需回投）
    this.deps.messageBroadcaster.broadcast(message).catch((err) => {
      this.deps.logger.error("Failed to broadcast weixin message", err instanceof Error ? err : undefined, {
        conversationId: conversation.id,
        messageId: message.id,
      });
    });

    // Agent 派发用原始 body（不含降级提示——运维文本不进 agent 上下文，检视建议 1；
    // 飞书同位置存在同样问题，独立 issue 跟踪）
    await this.dispatchAgent(conversation.id, body.trim(), fromUserId, outcome.injection);
    return true;
  }

  /** 未绑会话提示（媒体消息加「链接有时效」提醒——检视建议 2） */
  private async replyNoConversation(fromUserId: string, items: WeixinMediaGatewayItem[]): Promise<void> {
    const hasMedia = items.some(i => (i.type ?? 0) >= 2 && (i.type ?? 0) <= 5);
    await this.deps.weixinGateway.replyText(
      fromUserId,
      hasMedia
        ? "当前未进入任何对话，图片/媒体未接收（链接有时效）。请先使用 /in <对话ID> 进入对话后重发\n\n使用 /list 查看可用对话"
        : "当前未进入任何对话，请先使用 /in <对话ID> 进入对话\n\n使用 /list 查看可用对话",
    );
  }

  /** 命令分支：门禁 + 分发（命令集与飞书完全一致），每命令返回回复文本统一回发 */
  private async dispatchCommand(fromUserId: string, connectionId: string, text: string): Promise<void> {
    if (this.deps.partnerResolver?.configured && !this.deps.partnerResolver.isPartner(fromUserId)) {
      await this.deps.weixinGateway.replyText(fromUserId, "这些命令暂时不对所有人开放哦～直接聊天就行 🦦");
      return;
    }
    const reply = await this.executeCommand(connectionId, parseCommand(text));
    await this.deps.weixinGateway.replyText(fromUserId, reply);
  }

  private async executeCommand(connectionId: string, parsed: ReturnType<typeof parseCommand>): Promise<CommandReply> {
    switch (parsed.command) {
      case "list": {
        const conversations = await this.deps.manageConnection.listActiveConversations();
        return formatConversationList(conversations);
      }
      case "in": {
        try {
          await this.deps.manageConnection.enterConversation(connectionId, parsed.conversationId!);
          return `已进入对话: ${parsed.conversationId}`;
        } catch (err) {
          return `进入对话失败: ${err instanceof Error ? err.message : "Unknown error"}`;
        }
      }
      case "out": {
        await this.deps.manageConnection.leaveConversation(connectionId);
        return "已退出当前对话";
      }
      case "history": {
        const conversation = await this.deps.manageConnection.getCurrentConversation(connectionId);
        if (!conversation) {
          return "当前未进入任何对话，请先使用 /in <对话ID> 进入对话";
        }
        const messages = await this.deps.queryMessage.getMessages(conversation.id, { limit: 20 });
        return formatMessageHistory(messages);
      }
      case "help":
        return HELP_TEXT;
      case "unknown":
        return `未知命令: ${parsed.raw}\n\n${HELP_TEXT}`;
    }
  }

  private async dispatchAgent(conversationId: string, bodyText: string, senderId: string, injection?: WeixinMediaOutcome["injection"]): Promise<void> {
    const result = await this.deps.agentDispatchService.dispatch(conversationId, bodyText, senderId, injection);
    if (result.error) {
      this.deps.logger.error("Weixin agent dispatch failed", undefined, { conversationId, error: result.error });
    }
  }

  // ── 媒体支持（issue #567，照飞书 processMedia 语义）──

  /** 从入站消息提取媒体项（image/voice/file/video），无媒体返回空数组 */
  /** 媒体段编排：非图媒体收集降级提示，图片走 processMedia 管线（复杂度拆出） */
  private async composeMediaOutcome(items: WeixinMediaGatewayItem[], senderId: string): Promise<WeixinMediaOutcome> {
    const mediaItems = this.extractMediaItems(items);
    const unsupportedNotes = mediaItems
      .filter(m => m.kind !== "image")
      .map(m => `[${this.mediaKindLabel(m.kind)}：本期暂不支持接收，语音转写/文字不受影响]`);
    const imageItems = mediaItems.filter(m => m.kind === "image");
    const outcome = imageItems.length > 0
      ? await this.processMedia(imageItems, senderId)
      : { attachmentIds: [], degradeNote: null };
    return { ...outcome, degradeNote: this.joinNotes(unsupportedNotes, outcome.degradeNote) };
  }

  private extractMediaItems(items: WeixinMediaGatewayItem[]): WeixinMediaItemEntry[] {
    const out: WeixinMediaItemEntry[] = [];
    for (const item of items) {
      if (item.type === WeixinItemTypes.IMAGE && item.image_item) out.push({ kind: "image", item });
      else if (item.type === WeixinItemTypes.VOICE && item.voice_item) out.push({ kind: "voice", item });
      else if (item.type === WeixinItemTypes.FILE && item.file_item) out.push({ kind: "file", item });
      else if (item.type === WeixinItemTypes.VIDEO && item.video_item) out.push({ kind: "video", item });
    }
    return out;
  }

  /** 媒体处理主流程：下载网关 → 附件管线 → id + 注入载荷。单项失败单项降级 */
  private async processMedia(mediaItems: WeixinMediaItemEntry[], senderId: string): Promise<WeixinMediaOutcome> {
    // 管线未装配（旧部署未配 attachments / mediaGateway）：降级提示
    if (!this.deps.mediaGateway || !this.deps.attachmentUpload || !this.deps.attachmentInjection) {
      return { attachmentIds: [], degradeNote: "[媒体消息：服务器未启用附件功能，请到网页端查看]" };
    }

    const ids: string[] = [];
    const degradeNotes: string[] = [];
    for (const { item } of mediaItems) {
      try {
        const media = await this.deps.mediaGateway.downloadMediaItem(item);
        const att = await this.deps.attachmentUpload!.upload({
          stream: Readable.from(media.buffer),
          originalName: media.fileName,
          declaredMimeType: media.mimeType,
          uploaderId: senderId,
        });
        ids.push(att.id);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.deps.logger.warn("Weixin media ingestion failed", { error: reason });
        degradeNotes.push(`[媒体：接收失败：${reason}]`);
      }
    }

    // 注入载荷（与飞书/Web 同一份策略）；超限（>2 图）整组拒绝附件、保留正文
    let injection: WeixinMediaOutcome["injection"];
    if (ids.length > 0) {
      const validateErr = await this.deps.attachmentInjection!.validateForSend(ids);
      if (validateErr) {
        return { attachmentIds: [], degradeNote: this.joinNotes(degradeNotes, `[附件被拒：${validateErr}]`) };
      }
      injection = await this.deps.attachmentInjection!.buildInjectionPayload(ids);
    }

    this.deps.logger.info("Weixin media ingested", { itemCount: mediaItems.length, successCount: ids.length, degradeCount: degradeNotes.length });
    return { attachmentIds: ids, degradeNote: this.joinNotes(degradeNotes, null), injection };
  }

  private mediaKindLabel(kind: string): string {
    return kind === "image" ? "图片" : kind === "voice" ? "语音" : kind === "video" ? "视频" : "文件";
  }

  private joinNotes(notes: string[], extra: string | null): string | null {
    const all = extra ? [...notes, extra] : notes;
    return all.length > 0 ? all.join("\n") : null;
  }
}
