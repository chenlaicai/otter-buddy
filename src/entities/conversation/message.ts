/** 发送者类型（system 用于系统消息：Otter 进场/退场等事件通知） */
export type SenderType = "user" | "otter" | "system";

/**
 * 用户消息来源（标识消息从哪个前端接入点发送）。
 * 仅用户消息有意义；agent/系统消息不需要——它们广播给所有已连接前端。
 */
export type MessageSource = "web" | "feishu" | null;

/** 消息生命周期状态 */
export type MessageStatus = "streaming" | "speaking" | "completed" | "failed" | "aborted";

/** 消息事件类型 */
export type MessageEventType = "tool_result" | "assistant_toolcall" | "assistant_text" | "error";

/** 消息外部元数据（用于查重等场景，F20260805rbrg） */
export interface MessageMetadata {
  /** 单条消息去重 ID：`boss:{bossId}:{mid}` */
  externalId?: string;
  /** 批量消息去重 ID 数组（JSON 数组存储，配合 JSON_EACH 查询） */
  externalIds?: string[];
  /** 桥接状态事件类型（status kind 时填），如 "anti-bot-detected" */
  eventType?: string;
  /** 严重度（status kind 时填）：warning | critical */
  severity?: "warning" | "critical";
  /** 其他自定义键 */
  [key: string]: unknown;
}

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
  sequenceNum: number;
  contextTokens: number | null;
  contextTokensMax: number | null;
  source: MessageSource;
  /** 可选外部元数据（F20260805rbrg 招聘桥接用，旧消息为 null）。可选以避免破坏既有 Message 构造点。 */
  metadata?: MessageMetadata | null;
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
  return status === "completed" || status === "failed" || status === "aborted";
}

/**
 * 是否可以追加流式事件。
 * streaming 和 speaking 状态的消息可接收事件（agent loop 未结束）。
 */
export function canAppendEvent(status: MessageStatus): boolean {
  return status === "streaming" || status === "speaking";
}

/**
 * 是否可以开始发言（speak 工具调用）。
 * 仅 streaming 状态的消息可进入 speaking 状态。
 */
export function canStartSpeaking(status: MessageStatus): boolean {
  return status === "streaming";
}

/**
 * 是否可以完成消息。
 * speaking 状态的消息可被完成（agent loop 结束后，speak 已调用）。
 */
export function canCompleteMessage(status: MessageStatus): boolean {
  return status === "speaking";
}

/**
 * 是否可以标记消息失败。
 * streaming 和 speaking 状态的消息可被标记失败。
 */
export function canFailMessage(status: MessageStatus): boolean {
  return status === "streaming" || status === "speaking";
}

/**
 * 是否可以中止消息。
 * streaming 和 speaking 状态的消息可被中止。
 */
export function canAbortMessage(status: MessageStatus): boolean {
  return status === "streaming" || status === "speaking";
}

/**
 * 是否可以准备重试（yield 重试专用）。
 * 仅 failed 状态的消息可被重置为 streaming。
 * Why: failed 是终态，正常流程不可逆；yield 重试是唯一的合法重置路径。
 */
export function canPrepareForRetry(status: MessageStatus): boolean {
  return status === "failed";
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
 * - speaking/completed/aborted（user/otter）：必须非 null 且非空数组
 */
export function isValidTalkingStonePass(
  recipients: string[] | null,
  status: MessageStatus,
  senderType: SenderType,
): boolean {
  if (senderType === "system") return true;
  if (status === "streaming" || status === "failed") return true;
  /** speaking/completed/aborted 是终态或已声明发言——必须传递发言石 */
  return recipients !== null && recipients.length > 0;
}
