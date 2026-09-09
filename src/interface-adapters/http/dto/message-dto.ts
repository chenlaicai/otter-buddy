import type { Message, MessageEvent } from "@entities/conversation/message";
import { aggregateBody } from "@entities/conversation/message";
import type { SignalEvent } from "@entities/signal/signal-event";
import type {
  MessageDTO,
  MessageSegmentDTO,
  MessageEventDTO,
  MessageSignalDTO,
  AttachmentDTO,
} from "@contract/api/message";

export type { MessageDTO, MessageSegmentDTO, MessageEventDTO, AttachmentDTO };
export type { SendMessageRequestDTO, MessageListResponseDTO, UnreadStateDTO, MarkReadResponseDTO, MarkReadRequestDTO } from "@contract/api/message";

/** 计算消息持续时间 */
function duration(createdAt: string, completedAt: string | null): string | null {
  if (!completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(createdAt).getTime();
  return `${(ms / 1000).toFixed(1)}s`;
}

export function toMessageDTO(msg: Message, senderName?: string): MessageDTO {
  // 优先取持久化快照（层 1），为空串再取参数（层 2）
  const effectiveName = msg.senderName?.trim() ? msg.senderName : senderName;
  return {
    id: msg.id,
    st: msg.senderType,
    si: msg.senderId,
    content: aggregateBody(msg.segments),
    status: msg.status,
    ts: msg.createdAt,
    // 用户消息和系统消息不显示耗时（仅 agent 消息有意义）
    dur: msg.senderType === "otter" ? duration(msg.createdAt, msg.completedAt) : null,
    seq: msg.sequenceNum,
    tsp: msg.talkingStonePassedTo,
    turnId: msg.turnId,
    ...(effectiveName !== undefined && { sn: effectiveName }),
    ...(msg.contextTokens !== null && msg.contextTokens !== undefined && { ctx: msg.contextTokens }),
    ...(msg.contextTokensMax !== null && msg.contextTokensMax !== undefined && { ctxMax: msg.contextTokensMax }),
    ...(msg.source && msg.source !== "web" && { src: msg.source }),
    ...segmentsField(msg),
    // 多模态 Phase 1：透出附件引用（仅非空时携带）
    ...attachmentsField(msg),
  };
}

/** 分段数组字段（多 speak 气泡；空则不携带，前端 fallback 到 content） */
function segmentsField(msg: Message): Pick<MessageDTO, "segments"> | Record<string, never> {
  if (msg.segments.length === 0) return {};
  return { segments: msg.segments.map(s => ({ id: s.id, body: s.body, sequenceNum: s.sequenceNum })) };
}

/** 附件字段（多模态 Phase 1；空则不携带，向后兼容） */
function attachmentsField(msg: Message): Pick<MessageDTO, "atts"> | Record<string, never> {
  if (!msg.attachments || msg.attachments.length === 0) return {};
  return {
    atts: msg.attachments.map(a => ({
      id: a.id, kind: a.kind, originalName: a.originalName,
      mimeType: a.mimeType, sizeBytes: a.sizeBytes, width: a.width, height: a.height,
    } satisfies AttachmentDTO)),
  };
}

export function toMessageEventDTO(evt: MessageEvent): MessageEventDTO {
  return {
    id: evt.id,
    messageId: evt.messageId,
    eventType: evt.eventType,
    payload: evt.payload,
    sequenceNum: evt.sequenceNum,
    createdAt: evt.createdAt,
  };
}

/** F20260826mwrd C4：signal_events → 徽章 DTO（徽章在消息原位渲染的数据源） */
export function toMessageSignalDTO(evt: SignalEvent): MessageSignalDTO {
  return {
    id: evt.id,
    type: evt.type,
    severity: evt.severity,
    status: evt.status,
    payload: evt.payload,
    fromOtterId: evt.fromOtterId,
    ...(evt.targetOtterId !== null && { targetOtterId: evt.targetOtterId }),
    ...(evt.resolution !== null && { resolution: evt.resolution }),
    ...(evt.resolvedBy !== null && { resolvedBy: evt.resolvedBy }),
    createdAt: evt.createdAt,
  };
}

/** 搜索结果 DTO 已移除（搜索能力与分页冲突，完整移除） */
