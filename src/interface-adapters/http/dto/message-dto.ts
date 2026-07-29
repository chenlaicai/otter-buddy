import type { Message, MessageEvent } from "@entities/conversation/message";
import type {
  MessageDTO,
  MessageEventDTO,
} from "@contract/api/message";

export type { MessageDTO, MessageEventDTO };
export type { SendMessageRequestDTO } from "@contract/api/message";

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
    dur: duration(msg.createdAt, msg.completedAt),
    seq: msg.sequenceNum,
    tsp: msg.talkingStonePassedTo,
    turnId: msg.turnId,
    ...(senderName !== undefined && { sn: senderName }),
    ...(msg.contextTokens !== null && msg.contextTokens !== undefined && { ctx: msg.contextTokens }),
    ...(msg.contextTokensMax !== null && msg.contextTokensMax !== undefined && { ctxMax: msg.contextTokensMax }),
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
