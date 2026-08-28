import type { ManageConnection } from "@usecases/im/manage-connection";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { CommandDispatcher } from "./command-dispatcher";
import type { FeishuGateway } from "@usecases/im/feishu-gateway";
import type { FeishuUserInfoGateway } from "@usecases/im/feishu-user-info-gateway";
import type { PartnerResolver } from "@usecases/im/partner-resolver";
import type { AgentDispatchService } from "@usecases/conversation/agent-dispatch-service";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { FeishuResourceGateway } from "@usecases/im/feishu-resource-gateway";
import type { AttachmentUploadService } from "@usecases/conversation/attachment-upload-service";
import type { AttachmentInjectionService } from "@usecases/conversation/attachment-injection-service";
import type { FeishuMediaPayload } from "@usecases/im/feishu-long-connection-gateway";
import type { Logger } from "@usecases/ports/logger";
import { Readable } from "node:stream";

export interface FeishuIncomingMessage {
  chatId: string;
  text: string;
  senderId: string;
  messageId: string;
  /** 多模态 Phase 2：image/file 消息的媒体载荷（文本消息无此字段） */
  media?: FeishuMediaPayload;
}

/** 多模态 Phase 2：飞书 ingress 附件处理结果 */
interface FeishuAttachmentOutcome {
  /** 走完上传管线的附件 id（随 sendMessage 的 attachmentIds 入库） */
  attachmentIds: string[];
  /** 降级提示（下载失败/校验拒绝）——以可见文本进消息体，用户能感知 */
  degradeNote: string | null;
  /** 注入载荷（与 Web 路径同一份组装策略：image 真图 + document 文本块） */
  injection?: Awaited<ReturnType<AttachmentInjectionService["buildInjectionPayload"]>>;
}

export class FeishuMessageProcessor {
  constructor(
    private readonly deps: {
      manageConnection: ManageConnection;
      sendMessage: SendMessage;
      commandDispatcher: CommandDispatcher;
      feishuGateway: FeishuGateway;
      /** F20260826fuid：可选注入。未注入或解析失败时 senderName 快照为空，不影响主链路 */
      feishuUserInfo?: FeishuUserInfoGateway;
      /** F20260826fpbd：可选注入。命令门禁（方案B）；未注入或未配置时不拦 */
      partnerResolver?: PartnerResolver;
      /** 多模态 Phase 2：可选注入。未注入时 image/file 消息降级为占位文本（不丢消息） */
      feishuResource?: FeishuResourceGateway;
      attachmentUpload?: AttachmentUploadService;
      attachmentInjection?: AttachmentInjectionService;
      agentDispatchService: AgentDispatchService;
      messageBroadcaster: MessageBroadcaster;
      logger: Logger;
    },
  ) {}

  async process(msg: FeishuIncomingMessage): Promise<void> {
    const { chatId, text, senderId, messageId } = msg;

    this.deps.logger.info("Processing Feishu message", {
      chatId,
      messageId,
      messageType: msg.media?.type ?? "text",
      textLength: text.length,
    });

    const connection = await this.deps.manageConnection.ensureConnection(chatId, chatId);

    // 判断是否是命令（仅文本消息可能是命令；纯图片/文件消息跳过命令分支）
    if (text.startsWith("/") && !msg.media) {
      await this.dispatchCommand(chatId, connection.id, text, senderId);
      return;
    }

    // 普通消息：发送到当前绑定的 Conversation
    const conversation = await this.deps.manageConnection.getCurrentConversation(connection.id);
    if (!conversation) {
      await this.deps.feishuGateway.replyText(
        chatId,
        "当前未进入任何对话，请先使用 /in <对话ID> 进入对话\n\n使用 /list 查看可用对话"
      );
      return;
    }

    // 多模态 Phase 2：媒体消息先走附件管线（降级语义见 processMedia），再入消息库
    const outcome = msg.media ? await this.processMedia(msg, conversation.id, senderId) : { attachmentIds: [], degradeNote: null };
    const bodyText = this.composeBodyText(text, outcome);
    const attachmentIds = outcome.attachmentIds.length > 0 ? outcome.attachmentIds : undefined;

    await this.persistAndFanout(
      { chatId, senderId, conversationId: conversation.id, connectionId: connection.id },
      { bodyText, attachmentIds, injection: outcome.injection },
    );
  }

  /** 命令分支（F20260826fpbd 方案B门禁保留） */
  private async dispatchCommand(chatId: string, connectionId: string, text: string, senderId: string): Promise<void> {
    // F20260826fpbd（方案B）：会话管理命令仅搭档可用。拦截在消息入口而非 CommandDispatcher——
    // 命令分发器保持无身份概念，权限判定集中在 PartnerResolver 消费点；
    // 未配置 partnerOpenId 时不拦（降级，存量实例无感升级）
    if (this.deps.partnerResolver?.configured && !this.deps.partnerResolver.isPartner(senderId)) {
      await this.deps.feishuGateway.replyText(
        chatId,
        "这些命令暂时不对所有人开放哦～直接聊天就行 🦦",
      );
      return;
    }
    await this.deps.commandDispatcher.dispatch(connectionId, text, chatId);
  }

  /** 多模态 Phase 2：消息体组装——降级提示拼进 body；全降级时占位防空消息 */
  private composeBodyText(text: string, outcome: Pick<FeishuAttachmentOutcome, "attachmentIds" | "degradeNote">): string {
    let bodyText = text;
    if (outcome.degradeNote) {
      bodyText = bodyText ? `${bodyText}\n${outcome.degradeNote}` : outcome.degradeNote;
    }
    if (outcome.attachmentIds.length === 0 && !bodyText.trim()) {
      bodyText = "[媒体消息处理失败]";
    }
    return bodyText;
  }

  /** 入库 + 广播 + dispatch（自 process 拆出控复杂度） */
  private async persistAndFanout(
    ids: { chatId: string; senderId: string; conversationId: string; connectionId: string },
    payload: { bodyText: string; attachmentIds?: string[]; injection?: FeishuAttachmentOutcome["injection"] },
  ): Promise<void> {
    // 存消息（F20260826fuid：飞书消息带 senderDisplayName 快照，群聊多人可识别）
    const senderDisplayName = await this.resolveSenderName(ids.senderId);
    const { message, mentionFeedback } = await this.deps.sendMessage.send({
      conversationId: ids.conversationId,
      senderId: ids.senderId,
      senderType: "user",
      talkingStonePassedTo: [],
      body: payload.bodyText,
      source: "feishu",
      senderDisplayName,
      ...(payload.attachmentIds && { attachmentIds: payload.attachmentIds }),
    });

    this.deps.logger.info("Message saved to conversation", {
      connectionId: ids.connectionId,
      conversationId: ids.conversationId,
      messageId: message.id,
    });

    // F20260820i333: @提及解析失败时发送 feedback 给用户
    if (mentionFeedback) {
      await this.deps.feishuGateway.replyText(ids.chatId, mentionFeedback).catch(err => {
        this.deps.logger.error("Failed to send mention feedback", err instanceof Error ? err : undefined, {
          conversationId: ids.conversationId,
        });
      });
    }

    // 广播飞书消息到 Web 端（实时同步）
    this.deps.messageBroadcaster.broadcast(message).catch(err => {
      this.deps.logger.error("Failed to broadcast feishu message", err instanceof Error ? err : undefined, {
        conversationId: ids.conversationId,
        messageId: message.id,
      });
    });

    // 异步触发 Agent 派发（多模态 Phase 2：带附件注入载荷——图片真图 + 文档文本块）
    this.triggerAgentDispatch(ids.conversationId, payload.bodyText, ids.senderId, payload.injection);
  }

  /** 多模态 Phase 2：媒体消息处理——下载 → 上传管线 → 附件 id + 注入载荷。
   *  任何失败都降级为可见文本（消息不丢），不抛错中断主链路。 */
  private async processMedia(
    msg: FeishuIncomingMessage,
    conversationId: string,
    senderId: string,
  ): Promise<FeishuAttachmentOutcome> {
    const media = msg.media!;
    const kindLabel = media.type === "image" ? "图片" : "文件";

    // 管线未装配（旧部署未配 attachments）：降级提示
    if (!this.deps.feishuResource || !this.deps.attachmentUpload) {
      return { attachmentIds: [], degradeNote: `[${kindLabel}：服务器未启用附件功能]` };
    }

    try {
      const download = await this.deps.feishuResource.downloadMessageResource(
        msg.messageId,
        media.type === "image" ? media.imageKey! : media.fileKey!,
        media.type,
      );
      if (!download) {
        return { attachmentIds: [], degradeNote: `[${kindLabel}：下载失败（可能已过期或权限不足），请在网页端上传]` };
      }

      const att = await this.ingestThroughPipeline(msg, download, senderId);
      const ids = [att.id];

      // 注入载荷：与 Web 路径同一份策略（复用 AttachmentInjectionService 组装）。
      // 先 validateForSend 把关（≤2 图硬限制；飞书单消息单媒体本不会超，防御未来多媒体消息）。
      // attachmentInjection 与 feishuResource/attachmentUpload 在 platforms.ts 同块无条件装配，
      // 上方早退守卫已挡住未装配场景，这里用非空断言与 L237 统一风格
      const validateErr = await this.deps.attachmentInjection!.validateForSend(ids);
      if (validateErr) {
        return { attachmentIds: [], degradeNote: `[附件被拒：${validateErr}]` };
      }
      const injection = await this.deps.attachmentInjection!.buildInjectionPayload(ids);

      this.deps.logger.info("Feishu media ingested", {
        chatId: msg.chatId,
        messageId: msg.messageId,
        conversationId,
        kind: att.kind,
        attachmentId: att.id,
        sizeBytes: att.sizeBytes,
      });
      return { attachmentIds: ids, degradeNote: null, injection };
    } catch (err) {
      // 上传管线拒绝（类型白名单/大小超限）或意外异常：降级可见文本
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn("Feishu media ingestion failed", {
        chatId: msg.chatId,
        messageId: msg.messageId,
        error: reason,
      });
      return { attachmentIds: [], degradeNote: `[附件接收失败：${reason}]` };
    }
  }

  /** 下载字节 → 统一上传管线（校验/resize/去重免费复用） */
  private async ingestThroughPipeline(
    msg: FeishuIncomingMessage,
    download: { buffer: Buffer; fileName: string },
    senderId: string,
  ): Promise<{ id: string; kind: string; sizeBytes: number }> {
    const media = msg.media!;
    // 飞书不推原始文件名：image 用 image_key 短串、file 用飞书携带的 file_name；
    // 后端上传管线 sanitizeOriginalName 会清洗 + magic bytes 探嗅说了算（声明名仅辅助）
    const fileName = media.type === "image"
      ? `feishu-${media.imageKey!.slice(-12)}.png`
      : (media.fileName || download.fileName || `feishu-file-${media.fileKey!.slice(-8)}`);

    return this.deps.attachmentUpload!.upload({
      stream: Readable.from(download.buffer),
      originalName: fileName,
      declaredMimeType: media.type === "image" ? "image/png" : "application/octet-stream",
      uploaderId: senderId,
    });
  }

  /** F20260826fuid：open_id → 姓名。网关未注入/解析失败返回 null，永不阻塞消息入库 */
  private async resolveSenderName(senderId: string): Promise<string | null> {
    if (!this.deps.feishuUserInfo) return null;
    try {
      return await this.deps.feishuUserInfo.getUserName(senderId);
    } catch {
      return null;
    }
  }

  private triggerAgentDispatch(
    conversationId: string,
    userMessageContent: string,
    senderId: string,
    injection?: FeishuAttachmentOutcome["injection"],
  ): void {
    // 异步执行，不阻塞消息处理
    // Agent 事件通过 AgentInvoker.broadcastEvent 统一推送给所有订阅者
    // Agent 完成消息通过 AgentInvoker.broadcast 统一推送到外部渠道
    this.deps.agentDispatchService.dispatch(
      conversationId,
      userMessageContent,
      senderId,
      injection,
    ).then(result => {
      if (result.error) {
        this.deps.logger.error("Agent dispatch failed", undefined, {
          conversationId,
          error: result.error,
        });
      }
    }).catch(err => {
      this.deps.logger.error("Agent dispatch exception", err instanceof Error ? err : undefined, {
        conversationId,
      });
    });
  }
}
