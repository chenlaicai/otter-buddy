/**
 * 附件投影层（多模态支持 Phase 1）。
 *
 * 与 message-body-projection.ts 并列：附件在文本出口（FTS 索引、记忆索引、
 * 未读注入、list_messages/get_message、egress 广播通道）的统一占位投影。
 * 禁止各出口自写占位逻辑（html-card 投影漂移的教训）。
 *
 * 占位格式（方案 §3.5）：
 * - 图片：[图片: caption|文件名]——caption 存在时用 caption，Phase 2 worker
 *   上线前恒 NULL，降级文件名兜底
 * - 语音：[语音: 文件名 (size)]——#608 audio kind
 * - 文件：[文件: name (size)]（document/video 统一此格式）
 */

import type { AttachmentRef } from "./attachment";

/** 人类可读的文件大小（KB/MB） */
function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/**
 * 附件文本投影：附件数组 → 占位行（每附件一行）。
 * 空数组返回空串；调用方自行决定拼接位置（追加在 body 之后等）。
 */
export function projectAttachments(atts: AttachmentRef[]): string {
  if (!atts || atts.length === 0) return "";
  return atts
    .map(a => {
      if (a.kind === "image") {
        const label = a.caption?.trim() ? a.caption.trim() : a.originalName;
        return `[图片: ${label}]`;
      }
      if (a.kind === "audio") return `[语音: ${a.originalName} (${humanSize(a.sizeBytes)})]`;
      return `[文件: ${a.originalName} (${humanSize(a.sizeBytes)})]`;
    })
    .join("\n");
}
