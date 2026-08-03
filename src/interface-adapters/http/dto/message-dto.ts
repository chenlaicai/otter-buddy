import type { Message, MessageEvent } from "@entities/conversation/message";
import type {
  MessageDTO,
  MessageEventDTO,
  MessageSearchResultDTO,
} from "@contract/api/message";

export type { MessageDTO, MessageEventDTO };
export type { SendMessageRequestDTO, MessageListResponseDTO, MessageSearchResultDTO, UnreadStateDTO, MarkReadResponseDTO, MarkReadRequestDTO } from "@contract/api/message";

/** 计算消息持续时间 */
function duration(createdAt: string, completedAt: string | null): string | null {
  if (!completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(createdAt).getTime();
  return `${(ms / 1000).toFixed(1)}s`;
}

export function toMessageDTO(msg: Message, senderName?: string): MessageDTO {
  return {
    id: msg.id,
    st: msg.senderType,
    si: msg.senderId,
    content: msg.body,
    status: msg.status,
    ts: msg.createdAt,
    // 用户消息和系统消息不显示耗时（仅 agent 消息有意义）
    dur: msg.senderType === "otter" ? duration(msg.createdAt, msg.completedAt) : null,
    seq: msg.sequenceNum,
    tsp: msg.talkingStonePassedTo,
    turnId: msg.turnId,
    ...(senderName !== undefined && { sn: senderName }),
    ...(msg.contextTokens !== null && msg.contextTokens !== undefined && { ctx: msg.contextTokens }),
    ...(msg.contextTokensMax !== null && msg.contextTokensMax !== undefined && { ctxMax: msg.contextTokensMax }),
    ...(msg.source && msg.source !== "web" && { src: msg.source }),
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

/** 搜索结果 DTO（精简字段，复用 toMessageDTO 的字段映射逻辑） */
export function toMessageSearchResultDTO(
  msg: Message,
  senderName?: string,
): MessageSearchResultDTO {
  const dto = toMessageDTO(msg, senderName);
  return {
    id: dto.id,
    seq: dto.seq,
    content: dto.content ?? "",
    st: dto.st,
    ...(dto.sn !== undefined && { sn: dto.sn }),
    ts: dto.ts,
    turnId: dto.turnId,
  };
}
