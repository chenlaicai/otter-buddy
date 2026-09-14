/** Entry 实体：时间线中的一个条目，取代 Message */

/** 发送者类型 */
export type SenderType = "user" | "otter" | "system";

/** 条目类型 */
export type EntryType = "speak" | "user" | "invoke_start" | "invoke_end" | "yield" | "system";

/** 条目状态 */
export type EntryStatus = "streaming" | "speaking" | "completed" | "failed" | "aborted";

/** 消息来源 */
export type EntrySource = "web" | "feishu" | "weixin" | null;

/** 条目附件引用 */
import type { AttachmentRef } from "./attachment";

/** 条目元数据 */
export interface EntryMetadata {
  /** 外部去重 ID */
  externalId?: string;
  /** 批量外部去重 ID */
  externalIds?: string[];
  /** 桥接状态事件类型 */
  eventType?: string;
  /** 严重度 */
  severity?: "warning" | "critical";
  /** signal 销账标记（consumed） */
  signalMeta?: string;
  /** F20260913ctlv：注入方式（目标 running 时 steer=打断/followUp=排队；signal-router 消费） */
  injectionMode?: "steer" | "followUp";
  [key: string]: unknown;
}

/** 条目实体 */
export interface Entry {
  id: string;
  conversationId: string;
  /** 会话内全局序号（时间序） */
  sequenceNum: number;
  entryType: EntryType;

  /** 发言类条目专有（speak/user/system） */
  senderType: SenderType | null;
  senderId: string | null;
  body: string | null;

  /** invoke 关联（speak/yield/invoke_start/invoke_end 有值） */
  invokeId: string | null;

  /** yield 条目专有：行动权传递目标 */
  yieldTargets: string[] | null;

  /** 对话轮次分组 */
  turnId: string;
  status: EntryStatus;
  source: EntrySource;
  metadata: EntryMetadata | null;
  /** 发送者显示名快照 */
  senderName: string;
  contextTokens: number | null;
  contextTokensMax: number | null;
  createdAt: string;
  completedAt: string | null;
  /** 附件引用（多模态） */
  attachments?: AttachmentRef[];
}

/** 条目是否处于终态 */
export function isTerminalEntryStatus(status: EntryStatus): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

/** 是否可以开始发言 */
export function canStartSpeakingEntry(status: EntryStatus): boolean {
  return status === "streaming" || status === "speaking";
}

/** 是否可以完成条目 */
export function canCompleteEntry(status: EntryStatus): boolean {
  return status === "speaking";
}

/** 是否可以标记失败 */
export function canFailEntry(status: EntryStatus): boolean {
  return status === "streaming" || status === "speaking";
}

/** 是否可以中止 */
export function canAbortEntry(status: EntryStatus): boolean {
  return status === "streaming" || status === "speaking";
}

/** 完成条目时 body 是否合法 */
export function isValidCompletedEntry(entryType: EntryType, body: string | null): boolean {
  // speak/user/system 类型必须有 body
  if (entryType === "speak" || entryType === "user" || entryType === "system") {
    return body !== null && body.length > 0;
  }
  // invoke_start/invoke_end/yield 可以有也可以没有 body
  return true;
}
