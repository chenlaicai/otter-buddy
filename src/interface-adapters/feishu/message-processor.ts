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

    // #608（PR #603 检视建议 1 同款）：agent dispatch 用原始 text，不含降级提示——
    // 运维文本不进 agent 上下文；降级提示仅入消息库供用户可见（与微信侧同位置同修）
    const dispatchText = text.trim();

    await this.persistAndFanout(
      { chatId, senderId, conversationId: conversation.id, connectionId: connection.id },
      { bodyText, attachmentIds, injection: outcome.injection },
      dispatchText,
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

  /** 入库 + 广播 + dispatch（自 process 拆出控复杂度；dispatchText 与 bodyText 分离见 #608） */
  private async persistAndFanout(
    ids: { chatId: string; senderId: string; conversationId: string; connectionId: string },
    payload: { bodyText: string; attachmentIds?: string[]; injection?: FeishuAttachmentOutcome["injection"] },
    dispatchText: string,
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
    // #608：dispatchText 为原始正文（降级提示不进 agent 上下文，与微信侧同款）
    this.triggerAgentDispatch(ids.conversationId, dispatchText, ids.senderId, payload.injection);
  }

  /** 多模态 Phase 2：媒体消息处理——下载 → 上传管线 → 附件 id + 注入载荷。
   *  F20260829fpst：post 混排消息可能含多个媒体项——逐项下载/入库，单项失败单项降级
   *  （其余项照常）；全部媒体项走完后一次性 validateForSend（≤2 图硬限制，与 Web
   *  路径同一份策略）。任何失败都降级为可见文本（消息不丢），不抛错中断主链路。 */
  private async processMedia(
    msg: FeishuIncomingMessage,
    conversationId: string,
    senderId: string,
  ): Promise<FeishuAttachmentOutcome> {
    const items = this.mediaItems(msg.media!);
    const degradeNotes: string[] = [];

    // 管线未装配（旧部署未配 attachments）：降级提示（按媒体类别合并）
    if (!this.deps.feishuResource || !this.deps.attachmentUpload) {
      return { attachmentIds: [], degradeNote: this.missingPipelineNote(items) };
    }

    const ids: string[] = [];
    for (const item of items) {
      try {
        const download = await this.deps.feishuResource.downloadMessageResource(
          msg.messageId,
          item.key,
          item.kind,
        );
        if (!download) {
          degradeNotes.push(`[${this.kindLabel(item.kind)} ${this.keyTail(item.key)}：下载失败（可能已过期或权限不足），请在网页端上传]`);
          continue;
        }
        const att = await this.ingestThroughPipeline(item, download, senderId);
        ids.push(att.id);
      } catch (err) {
        // 上传管线拒绝（类型白名单/大小超限）或意外异常：单项降级可见文本，其余项继续
        const reason = err instanceof Error ? err.message : String(err);
        this.deps.logger.warn("Feishu media ingestion failed", {
          chatId: msg.chatId,
          messageId: msg.messageId,
          resourceKey: item.key,
          error: reason,
        });
        degradeNotes.push(`[${this.kindLabel(item.kind)} ${this.keyTail(item.key)}：附件接收失败：${reason}]`);
      }
    }

    // 注入载荷：与 Web 路径同一份策略（复用 AttachmentInjectionService 组装）。
    // 先 validateForSend 把关（≤2 图硬限制；超限时整组拒绝附件、保留正文，降级提示可见）。
    // attachmentInjection 与 feishuResource/attachmentUpload 在 platforms.ts 同块无条件装配，
    // 早退守卫已挡未装配场景，这里用非空断言统一风格。
    let injection: FeishuAttachmentOutcome["injection"];
    if (ids.length > 0) {
      const validateErr = await this.deps.attachmentInjection!.validateForSend(ids);
      if (validateErr) {
        return { attachmentIds: [], degradeNote: this.joinNotes(degradeNotes, `[附件被拒：${validateErr}]`) };
      }
      injection = await this.deps.attachmentInjection!.buildInjectionPayload(ids);
    }

    this.deps.logger.info("Feishu media ingested", {
      chatId: msg.chatId,
      messageId: msg.messageId,
      conversationId,
      itemCount: items.length,
      successCount: ids.length,
      degradeCount: degradeNotes.length,
    });
    return { attachmentIds: ids, degradeNote: this.joinNotes(degradeNotes, null), injection };
  }

  /** 媒体载荷 → 下载项列表（image/file 单项；post 为段落媒体项列表） */
  private mediaItems(media: FeishuMediaPayload): Array<{ kind: "image" | "file"; key: string; fileName?: string }> {
    if (media.type === "post") {
      return (media.postItems ?? []).map(i => ({ kind: i.kind, key: i.key, fileName: i.fileName }));
    }
    if (media.type === "image") return [{ kind: "image", key: media.imageKey! }];
    return [{ kind: "file", key: media.fileKey!, fileName: media.fileName }];
  }

  private kindLabel(kind: "image" | "file"): string {
    return kind === "image" ? "图片" : "文件";
  }

  /** 资源 key 尾串（降级提示里区分多个媒体项用；无 key 时返回空串） */
  private keyTail(key: string): string {
    return key.length > 0 ? key.slice(-8) : "";
  }

  private missingPipelineNote(items: Array<{ kind: string }>): string {
    const kinds = new Set(items.map(i => i.kind));
    const labels = [...kinds].map(k => (k === "image" ? "图片" : "文件"));
    return `[${labels.join("/")}：服务器未启用附件功能]`;
  }

  /** 多条降级提示拼接（无提示时 null——composeBodyText 拼接时判空） */
  private joinNotes(notes: string[], extra: string | null): string | null {
    const all = extra ? [...notes, extra] : notes;
    return all.length > 0 ? all.join("\n") : null;
  }

  /** 下载字节 → 统一上传管线（校验/resize/去重免费复用）。
   *  F20260829fpst：按媒体项参数化（post 混排逐项复用，image/file 单项同路）。 */
  private async ingestThroughPipeline(
    item: { kind: "image" | "file"; key: string; fileName?: string },
    download: { buffer: Buffer; fileName: string },
    senderId: string,
  ): Promise<{ id: string; kind: string; sizeBytes: number }> {
    // 飞书不推原始文件名：image 用 image_key 短串、file 用飞书携带的 file_name；
    // 后端上传管线 sanitizeOriginalName 会清洗 + magic bytes 探嗅说了算（声明名仅辅助）
    const fileName = item.kind === "image"
      ? `feishu-${item.key.slice(-12)}.png`
      : (item.fileName || download.fileName || `feishu-file-${item.key.slice(-8)}`);

    return this.deps.attachmentUpload!.upload({
      stream: Readable.from(download.buffer),
      originalName: fileName,
      declaredMimeType: item.kind === "image" ? "image/png" : "application/octet-stream",
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
