/**
 * #1191（F20260928rmix）：SendEntry 消息索引辅助（独立模块降主文件行数）。
 *
 * user 侧索引正文构建 + 发送意图附件 refs 加载——从 send-entry.ts 抽出，
 * 语义见特性文档 A 节（旧 SendMessage buildIndexBody 同构：attach 失败也投影）。
 */
import type { AttachmentRef } from "@entities/conversation/attachment";
import { projectAttachments } from "@entities/conversation/attachment-projection";
import { stripHtmlCardFences } from "@entities/conversation/message-body-projection";
import type { EntryRepository } from "./entry-repository";
import type { Logger } from "@usecases/ports/logger";

/** #1191：user 侧索引正文 = 剥围栏正文 + 附件占位投影行（旧 SendMessage buildIndexBody 同构） */
export function buildUserIndexBody(body: string, attachments: AttachmentRef[]): string {
  const projection = projectAttachments(attachments);
  const stripped = stripHtmlCardFences(body);
  return projection ? `${stripped}\n${projection}` : stripped;
}

/** #1191：按发送意图加载附件投影 refs（attach 失败也投影——旧口径 attachmentRefs 同语义）。
 *  查不到的 id（已删/毒数据）静默跳过，索引面不固化为硬错 */
export async function loadAttachmentRefs(
  entryRepo: EntryRepository,
  logger: Logger,
  attachmentIds?: string[],
): Promise<AttachmentRef[]> {
  if (!attachmentIds || attachmentIds.length === 0) return [];
  try {
    return await entryRepo.getAttachmentRefsByIds(attachmentIds);
  } catch (err) {
    logger.warn("Failed to load attachment refs for memory index (non-fatal)", {
      attachmentIds,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
