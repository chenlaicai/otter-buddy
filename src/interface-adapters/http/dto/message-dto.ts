import type { Attachment } from "@entities/conversation/conversation";
import type { Message, MessageEvent } from "@entities/conversation/message";

/**
 * 消息响应 DTO（前端短字段名映射，D57）。
 * st=senderType, si=senderId, content=body, ts=createdAt, dur=duration
 */
export interface MessageDTO {
  id: string;
  st: string;
  si: string;
  content: string | null;
  status: string;
  ts: string;
  dur: string | null;
  seq: number;
  tsp: string[] | null;
  turnId: string;
  attachments: Attachment[] | null;
}

/** 消息事件 DTO */
export interface MessageEventDTO {
  id: string;
  messageId: string;
  eventType: string;
  payload: Record<string, unknown>;
  sequenceNum: number;
  createdAt: string;
}

/** 发送消息请求 DTO */
export interface SendMessageRequestDTO {
  senderId: string;
  talkingStonePassedTo: string[];
  body: string;
  attachments?: Attachment[];
}

/** 计算消息持续时间 */
function duration(createdAt: string, completedAt: string | null): string | null {
  if (!completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(createdAt).getTime();
  return `${(ms / 1000).toFixed(1)}s`;
}

export function toMessageDTO(msg: Message): MessageDTO {
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
    attachments: msg.attachments,
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
