/**
 * domain/conversation 领域模型类型定义。
 *
 * 对话模块管理对话生命周期、消息 append-only 存储、对话树结构和对话关键信息。
 * 依赖仅 infra/db，模块自包含。
 */

export type ConversationStatus = "active" | "completed" | "archived";
export type SenderType = "user" | "otter";

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
  content: string;
  attachments: Attachment[] | null;
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

export interface MessageInput {
  senderType: SenderType;
  senderId: string;
  content: string;
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
