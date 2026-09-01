/**
 * 附件实体（多模态支持 Phase 1）。
 *
 * 附件与消息解耦：先上传拿 ID，再随消息引用（message_attachments 关联表）。
 * attachments 表为后端域能力——存储、去重、MIME 校验、投影、LLM 注入全在后端，
 * 任何前端通道（web/feishu）不持有私有附件实现。
 */

/** 附件种类（#608：audio/video 入白名单；PDF 落 document） */
export type AttachmentKind = "image" | "document" | "audio" | "video";

/**
 * 附件引用（Message.attachments 挂载的最小投影）。
 * 广播链路（message-broadcaster）走 entities 层 Message 不经 DTO——
 * egress 通道（feishu projectForChannel）从该字段做附件投影。
 */
export interface AttachmentRef {
  id: string;
  kind: AttachmentKind;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  caption: string | null;
}

/** 附件完整实体（attachments 表行；含存储路径等后端内部字段） */
export interface Attachment extends AttachmentRef {
  sha256: string;
  filePath: string;
  uploaderId: string;
  createdAt: string;
}

/** 消息-附件关联（message_attachments 表行） */
export interface MessageAttachmentLink {
  messageId: string;
  attachmentId: string;
  sequenceNum: number;
}
