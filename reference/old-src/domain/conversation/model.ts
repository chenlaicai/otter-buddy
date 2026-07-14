/**
 * domain/conversation 领域模型类型定义。
 *
 * 对话模块管理对话生命周期、消息 append-only 存储、对话树结构和对话关键信息。
 * 依赖仅 infra/db，模块自包含。
 */

export type ConversationStatus = "active" | "completed" | "archived";
export type SenderType = "user" | "otter";

/** 消息生命周期状态 */
export type MessageStatus = "streaming" | "completed" | "failed";

/** 流式事件类型 */
export type MessageEventType = "text_delta" | "tool_call" | "tool_result" | "error";

// ===== 实体 =====

export interface Conversation {
  id: string;
  title: string;
  status: ConversationStatus;
  parentId: string | null;
  treePath: string;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  senderType: SenderType;
  senderId: string;
  status: MessageStatus;
  body: string | null;
  attachments: Attachment[] | null;
  sequenceNum: number;
  createdAt: string;
  completedAt: string | null;
}

export interface MessageEvent {
  id: string;
  messageId: string;
  eventType: MessageEventType;
  payload: Record<string, unknown>;
  sequenceNum: number;
  createdAt: string;
}

export interface KeyFact {
  id: string;
  conversationId: string;
  content: string;
  category: string | null;
  userFlagged: boolean;
  createdBy: string;
  otterId: string | null;
  createdAt: string;
}

export interface LinkedResource {
  id: string;
  conversationId: string;
  resourceType: string;
  url: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
  linkedBy: string;
  otterId: string | null;
  autoLinked: boolean;
  createdAt: string;
}

// ===== 组合值对象 =====

export interface KeyInfo {
  keyFacts: KeyFact[];
  linkedResources: LinkedResource[];
}

export interface ConversationTreeNode {
  conversation: Conversation;
  children: ConversationTreeNode[];
}

// ===== 输入类型 =====

/** 用户消息输入（立即完成，body 必填） */
export interface MessageInput {
  senderType: SenderType;
  senderId: string;
  body: string;
  attachments?: Attachment[];
}

/** Otter 消息启动输入（streaming 阶段，无 body） */
export interface StartMessageInput {
  senderId: string;
  attachments?: Attachment[];
}

/** 流式事件输入 */
export interface MessageEventInput {
  eventType: MessageEventType;
  payload: Record<string, unknown>;
}

/** 完成消息输入 */
export interface CompleteMessageInput {
  body: string;
  /** 不提供时保留 startMessage 时的预置 attachments */
  attachments?: Attachment[];
}

export interface KeyFactInput {
  content: string;
  category?: string;
  createdBy: string;
  otterId?: string;
}

export interface LinkedResourceInput {
  resourceType: string;
  url: string;
  title?: string;
  metadata?: Record<string, unknown>;
  linkedBy: string;
  otterId?: string;
}

export interface Attachment {
  type: string;
  url: string;
  name?: string;
}
