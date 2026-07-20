import type {
  ArtifactStatus,
  Conversation,
  ConversationStatus,
  Turn,
  KeyFact,
  LinkedResource,
  Attachment,
  ConversationParticipant,
} from "@entities/conversation/conversation";
import type {
  Message,
  MessageEvent,
  MessageStatus,
} from "@entities/conversation/message";

export interface GetMessagesOptions {
  limit?: number;
  before?: string;
  status?: MessageStatus;
  turnId?: string;
}

/** Turn 历史条目（含该 Turn 下的消息） */
export interface TurnHistoryEntry {
  turn: Turn;
  messages: Message[];
}

export interface ConversationRepository {
  // Conversation CRUD
  create(conversation: Conversation, otterIds?: string[]): Promise<void>;
  getById(id: string): Promise<Conversation | null>;
  updateStatus(
    id: string,
    status: ConversationStatus,
    timestamp: string,
  ): Promise<void>;
  getIdsByOtterId(otterId: string): Promise<string[]>;

  // 对话参与者
  getOtterIds(conversationId: string): Promise<string[]>;

  // Turn 管理
  createTurn(turn: Turn): Promise<void>;
  getActiveTurn(conversationId: string): Promise<Turn | null>;
  closeTurn(turnId: string, closedAt: string): Promise<void>;
  getMaxTurnNumber(conversationId: string): Promise<number>;
  getMessagesByTurnId(turnId: string): Promise<Message[]>;

  // Message 生命周期
  createCompletedMessage(message: Message): Promise<void>;
  createStreamingMessage(message: Message): Promise<void>;
  completeMessage(input: {
    messageId: string;
    body: string;
    talkingStonePassedTo: string[];
    attachments: Attachment[] | null;
    completedAt: string;
    contextTokens?: number;
    contextTokensMax?: number;
  }): Promise<void>;
  failMessage(messageId: string, failedAt: string): Promise<void>;
  /** 中止消息：streaming -> aborted（body 必须非空，talkingStonePassedTo 必须非空） */
  abortMessage(
    messageId: string,
    body: string,
    talkingStonePassedTo: string[],
    abortedAt: string,
  ): Promise<void>;
  getMaxSequenceNum(conversationId: string): Promise<number>;

  // Message 查询
  getMessageById(id: string): Promise<Message | null>;
  getMessages(
    conversationId: string,
    options: GetMessagesOptions,
  ): Promise<Message[]>;
  getMessagesBefore(messageId: string, count: number): Promise<Message[]>;
  getMessagesAfter(messageId: string, count: number): Promise<Message[]>;

  // MessageEvent
  appendEvent(event: MessageEvent): Promise<void>;
  getMessageEvents(messageId: string): Promise<MessageEvent[]>;
  getMaxEventSequenceNum(messageId: string): Promise<number>;

  // Message 全文搜索（FTS5）
  searchMessages(conversationId: string, query: string, limit?: number): Promise<Message[]>;

  // Turn 历史（含消息）
  getTurnHistory(conversationId: string, includeMessages?: boolean): Promise<TurnHistoryEntry[]>;

  // Key Info
  addKeyFact(keyFact: KeyFact): Promise<void>;
  linkResource(resource: LinkedResource): Promise<void>;
  getKeyFacts(conversationId: string): Promise<KeyFact[]>;
  getLinkedResources(conversationId: string, filters?: { status?: ArtifactStatus; resourceType?: string }): Promise<LinkedResource[]>;
  getLinkedResourceById(id: string): Promise<LinkedResource | null>;
  getLinkedResourcesByGroup(conversationId: string, groupId: string): Promise<LinkedResource[]>;
  updateResourceStatus(id: string, status: ArtifactStatus, statusChangedAtTurnNumber: number, supersededBy?: string): Promise<void>;
  supersedeLinkedResource(existingId: string, newResource: LinkedResource, statusChangedAtTurnNumber: number): Promise<void>;
  deleteKeyFact(id: string): Promise<void>;
  flagKeyFact(id: string, flagged: boolean): Promise<void>;
  deleteLinkedResource(id: string): Promise<void>;

  // Participant 管理（UA-4~UA-10）
  createParticipant(participant: ConversationParticipant): Promise<void>;
  createParticipants(participants: ConversationParticipant[]): Promise<void>;
  getParticipant(
    conversationId: string,
    otterId: string,
  ): Promise<ConversationParticipant | null>;
  getActiveParticipants(
    conversationId: string,
  ): Promise<ConversationParticipant[]>;
  updateParticipantLeave(
    participantId: string,
    leftAtTurnId: string,
    leftAtTurnNumber: number,
    leftAt: string,
  ): Promise<void>;
}
