import type { Attachment } from "./conversation";

/** 消息响应 DTO（前端短字段名映射，D57） */
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
