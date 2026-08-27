/**
 * 附件仓储接口（多模态 Phase 1）。
 *
 * usecases 层 port：上传管线/消息组装/投影出口都依赖本接口，
 * SQLite 实现在 frameworks/db/attachment/sqlite-attachment-repository.ts。
 */

import type { Attachment, AttachmentRef } from "@entities/conversation/attachment";

export interface AttachmentRepository {
  /** 插入附件行。sha256+uploader_id 撞唯一索引时抛 AttachmentDuplicateError（携带已有行） */
  insert(attachment: Attachment): Promise<void>;
  /** 按 sha256+uploader 查重（撞唯一索引前的预查与降级路径） */
  findBySha256(sha256: string, uploaderId: string): Promise<Attachment | null>;
  getById(id: string): Promise<Attachment | null>;
  getByIds(ids: string[]): Promise<Attachment[]>;
  /** 消息-附件关联批量写入（同事务） */
  linkMessageAttachments(messageId: string, attachmentIds: string[]): Promise<void>;
  /** 批量取消息附件引用（消息组装点①：repository 加载回填） */
  getAttachmentRefsByMessageIds(messageIds: string[]): Promise<Map<string, AttachmentRef[]>>;
}
