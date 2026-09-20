import type {
  ArtifactStatus,
  Conversation,
  ConversationStatus,
  ConversationParticipant,
  LinkedResource,
  ParticipantStatus,
} from "@entities/conversation/conversation";
import type {
  Message,
  MessageEvent,
  MessageEventType,
  MessageMetadata,
  MessageSegment,
  MessageSource,
  MessageStatus,
  SenderType,
} from "@entities/conversation/message";

export interface ConversationRow {
  id: string;
  title: string;
  status: string;
  summary: string | null;
  pinned: number;
  /** F20260920imax：对话类别（迁移后存量库恒有值；PRAGMA 探测前的旧列无值场景不会走到这里） */
  kind?: string;
  workspace_dir: string | null;
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
  sequence_num: number;
  talking_stone_passed_to: string | null;
  context_tokens: number | null;
  context_tokens_max: number | null;
  source: string;
  metadata: string | null;
  sender_name: string;
  created_at: string;
  completed_at: string | null;
  signal_level: string | null;
  signal_meta: string | null;
}

export interface MessageEventRow {
  id: string;
  message_id: string;
  event_type: string;
  payload: string;
  sequence_num: number;
  created_at: string;
}

export interface LinkedResourceRow {
  id: string;
  conversation_id: string;
  resource_type: string;
  url: string | null;
  title: string | null;
  content: string | null;
  category: string | null;
  user_flagged: number;
  metadata: string | null;
  linked_by: string;
  otter_id: string | null;
  auto_linked: number;
  created_at: string;
  status: string;
  group_id: string | null;
  superseded_by: string | null;
}

export interface ParticipantRow {
  id: string;
  conversation_id: string;
  otter_id: string;
  status: string;
  created_at: string;
  left_at: string | null;
}

export function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    status: row.status as ConversationStatus,
    summary: row.summary,
    pinned: row.pinned === 1,
    kind: row.kind === "assistant" ? "assistant" : "normal",
    workspaceDir: row.workspace_dir ?? null,
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
    talkingStonePassedTo: row.talking_stone_passed_to
      ? (JSON.parse(row.talking_stone_passed_to) as string[])
      : null,
    status: row.status as MessageStatus,
    segments: [], // populated by repository after fetch
    sequenceNum: row.sequence_num,
    contextTokens: row.context_tokens,
    contextTokensMax: row.context_tokens_max,
    source: (row.source ?? "web") as MessageSource,
    metadata: row.metadata ? (JSON.parse(row.metadata) as MessageMetadata) : null,
    senderName: row.sender_name ?? '',
    createdAt: row.created_at,
    completedAt: row.completed_at,
    signalLevel: row.signal_level ?? null,
    signalMeta: row.signal_meta ?? null,
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

export function rowToLinkedResource(row: LinkedResourceRow): LinkedResource {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    resourceType: row.resource_type,
    url: row.url,
    title: row.title,
    content: row.content,
    category: row.category,
    userFlagged: row.user_flagged === 1,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : null,
    linkedBy: row.linked_by,
    otterId: row.otter_id,
    autoLinked: row.auto_linked === 1,
    createdAt: row.created_at,
    status: row.status as ArtifactStatus,
    groupId: row.group_id,
    supersededBy: row.superseded_by,
  };
}

export function rowToParticipant(row: ParticipantRow): ConversationParticipant {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    otterId: row.otter_id,
    status: row.status as ParticipantStatus,
    createdAt: row.created_at,
    leftAt: row.left_at,
  };
}

export interface SegmentRow {
  id: string;
  message_id: string;
  body: string;
  sequence_num: number;
  created_at: string;
}

export function rowToSegment(row: SegmentRow): MessageSegment {
  return {
    id: row.id,
    messageId: row.message_id,
    body: row.body,
    sequenceNum: row.sequence_num,
    createdAt: row.created_at,
  };
}
