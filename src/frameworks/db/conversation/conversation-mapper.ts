import type {
  ArtifactStatus,
  Attachment,
  Conversation,
  ConversationStatus,
  ConversationParticipant,
  KeyFact,
  LinkedResource,
  ParticipantStatus,
  Turn,
  TurnStatus,
} from "@entities/conversation/conversation";
import type {
  Message,
  MessageEvent,
  MessageEventType,
  MessageStatus,
  SenderType,
} from "@entities/conversation/message";

export interface ConversationRow {
  id: string;
  title: string;
  status: string;
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
  turn_id: string;
  talking_stone_passed_to: string | null;
  context_tokens: number | null;
  context_tokens_max: number | null;
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
  status: string;
  linked_at_turn_number: number;
  status_changed_at_turn_number: number;
  group_id: string | null;
  superseded_by: string | null;
}

export interface TurnRow {
  id: string;
  conversation_id: string;
  turn_number: number;
  status: string;
  created_at: string;
  closed_at: string | null;
}

export interface ParticipantRow {
  id: string;
  conversation_id: string;
  otter_id: string;
  joined_at_turn_id: string | null;
  joined_at_turn_number: number;
  left_at_turn_id: string | null;
  left_at_turn_number: number | null;
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
    turnId: row.turn_id as string,
    senderType: row.sender_type as SenderType,
    senderId: row.sender_id,
    talkingStonePassedTo: row.talking_stone_passed_to
      ? (JSON.parse(row.talking_stone_passed_to) as string[])
      : null,
    status: row.status as MessageStatus,
    body: row.body,
    attachments: row.attachments
      ? (JSON.parse(row.attachments) as Attachment[])
      : null,
    sequenceNum: row.sequence_num,
    contextTokens: row.context_tokens,
    contextTokensMax: row.context_tokens_max,
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
    status: row.status as ArtifactStatus,
    linkedAtTurnNumber: row.linked_at_turn_number,
    statusChangedAtTurnNumber: row.status_changed_at_turn_number,
    groupId: row.group_id,
    supersededBy: row.superseded_by,
  };
}

export function rowToTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnNumber: row.turn_number,
    status: row.status as TurnStatus,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

export function rowToParticipant(row: ParticipantRow): ConversationParticipant {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    otterId: row.otter_id,
    joinedAtTurnId: row.joined_at_turn_id,
    joinedAtTurnNumber: row.joined_at_turn_number,
    leftAtTurnId: row.left_at_turn_id,
    leftAtTurnNumber: row.left_at_turn_number,
    status: row.status as ParticipantStatus,
    createdAt: row.created_at,
    leftAt: row.left_at,
  };
}
