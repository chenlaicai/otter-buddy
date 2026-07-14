/**
 * 领域对象 <-> DB 行映射。
 *
 * 映射规则参见 F20260713c7p2 设计文档。
 */

import type {
  Attachment,
  Conversation,
  ConversationStatus,
  KeyFact,
  LinkedResource,
  Message,
  MessageEvent,
  MessageEventType,
  MessageStatus,
  SenderType,
} from "../model";

// ===== DB 行类型 =====

export interface ConversationRow {
  id: string;
  title: string;
  status: string;
  parent_id: string | null;
  tree_path: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  archived_at: string | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_type: string;
  sender_id: string;
  status: string;
  body: string | null;
  attachments: string | null;
  sequence_num: number;
  created_at: string;
  completed_at: string | null;
}

export interface MessageEventRow {
  id: string;
  message_id: string;
  event_type: string;
  payload: string;
  sequence_num: number;
  created_at: string;
}

export interface KeyFactRow {
  id: string;
  conversation_id: string;
  content: string;
  category: string | null;
  user_flagged: number;
  created_by: string;
  otter_id: string | null;
  created_at: string;
}

export interface LinkedResourceRow {
  id: string;
  conversation_id: string;
  resource_type: string;
  url: string;
  title: string | null;
  metadata: string | null;
  linked_by: string;
  otter_id: string | null;
  auto_linked: number;
  created_at: string;
}

// ===== 映射函数 =====

export function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    status: row.status as ConversationStatus,
    parentId: row.parent_id,
    treePath: row.tree_path,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    archivedAt: row.archived_at,
  };
}

export function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderType: row.sender_type as SenderType,
    senderId: row.sender_id,
    status: row.status as MessageStatus,
    body: row.body,
    attachments: row.attachments
      ? (JSON.parse(row.attachments) as Attachment[])
      : null,
    sequenceNum: row.sequence_num,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function rowToMessageEvent(row: MessageEventRow): MessageEvent {
  return {
    id: row.id,
    messageId: row.message_id,
    eventType: row.event_type as MessageEventType,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    sequenceNum: row.sequence_num,
    createdAt: row.created_at,
  };
}

export function rowToKeyFact(row: KeyFactRow): KeyFact {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    content: row.content,
    category: row.category,
    userFlagged: row.user_flagged === 1,
    createdBy: row.created_by,
    otterId: row.otter_id,
    createdAt: row.created_at,
  };
}

export function rowToLinkedResource(row: LinkedResourceRow): LinkedResource {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    resourceType: row.resource_type,
    url: row.url,
    title: row.title,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : null,
    linkedBy: row.linked_by,
    otterId: row.otter_id,
    autoLinked: row.auto_linked === 1,
    createdAt: row.created_at,
  };
}
