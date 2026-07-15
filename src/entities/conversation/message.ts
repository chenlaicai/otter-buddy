import type { Attachment } from "./conversation";

/** 发送者类型（system 用于系统消息：Otter 进场/退场等事件通知） */
export type SenderType = "user" | "otter" | "system";

/** 消息生命周期状态 */
export type MessageStatus = "streaming" | "completed" | "failed";

/** 流式事件类型 */
export type MessageEventType = "text_delta" | "tool_call" | "tool_result" | "error";

/** 消息实体（含发言石传递） */
export interface Message {
  id: string;
  conversationId: string;
  turnId: string;
  senderType: SenderType;
  senderId: string;
  talkingStonePassedTo: string[] | null; // 发言石传递：streaming 时为 null，completed 时必填非空。对齐 Snail 的 to_speakers 模式
  status: MessageStatus;
  body: string | null;
  attachments: Attachment[] | null;
  sequenceNum: number;
  createdAt: string;
  completedAt: string | null;
}

/** 消息流式事件实体 */
export interface MessageEvent {
  id: string;
  messageId: string;
  eventType: MessageEventType;
  payload: Record<string, unknown>;
  sequenceNum: number;
  createdAt: string;
}

/**
 * 消息是否处于终态（不可再转换）。
 * completed 和 failed 是终态。
 */
export function isTerminalMessageStatus(status: MessageStatus): boolean {
  return status === "completed" || status === "failed";
}

/**
 * 是否可以追加流式事件。
 * 仅 streaming 状态的消息可接收事件。
 * 来源：旧 adapter.ts appendEvent() 方法中的状态校验
 */
export function canAppendEvent(status: MessageStatus): boolean {
  return status === "streaming";
}

/**
 * 是否可以完成消息。
 * 仅 streaming 状态的消息可被完成。
 * 来源：旧 adapter.ts completeMessage() 方法中的状态校验
 */
export function canCompleteMessage(status: MessageStatus): boolean {
  return status === "streaming";
}

/**
 * 是否可以标记消息失败。
 * 仅 streaming 状态的消息可被标记失败。
 * 来源：旧 adapter.ts failMessage() 方法中的状态校验
 */
export function canFailMessage(status: MessageStatus): boolean {
  return status === "streaming";
}

/**
 * 完成消息时 body 是否合法。
 * completed 状态的 Message 必须有非空 body——这是实体状态不变量，
 * 任何 use case 调用 completeMessage 时都必须遵守。
 * 来源：旧 adapter.ts completeMessage() 方法中的 `if (!completion.body)` 校验
 */
export function isValidCompletedMessageBody(body: string): boolean {
  return body.length > 0;
}

/**
 * 发言石传递是否合法（UA-8 规则）。
 *
 * - system：始终豁免（系统消息不传递发言石）
 * - streaming/failed：可为 null 或空数组（body 为 null，发言石无意义）
 * - completed（user/otter）：必须非 null 且非空数组
 */
export function isValidTalkingStonePass(
  recipients: string[] | null,
  status: MessageStatus,
  senderType: SenderType,
): boolean {
  if (senderType === "system") return true;
  if (status === "streaming" || status === "failed") return true;
  return recipients !== null && recipients.length > 0;
}
