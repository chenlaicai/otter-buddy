import type {
  ArtifactStatus,
  Conversation,
  ConversationStatus,
  Turn,
  LinkedResource,
  ConversationParticipant,
} from "@entities/conversation/conversation";
import type {
  Message,
  MessageEvent,
  MessageStatus,
  SenderType,
} from "@entities/conversation/message";

export interface GetMessagesOptions {
  limit?: number;
  before?: string;
  status?: MessageStatus;
  senderType?: SenderType;
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
  getAllIds(options?: { limit?: number; offset?: number }): Promise<string[]>;
  updatePinned(id: string, pinned: boolean): Promise<void>;

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
  /** 开始发言：streaming → speaking，暂存 body + 发言石目标 */
  startSpeaking(messageId: string, body: string, talkingStonePassedTo: string[]): Promise<void>;
  completeMessage(input: {
    messageId: string;
    body: string;
    talkingStonePassedTo: string[];
    completedAt: string;
    contextTokens?: number;
    contextTokensMax?: number;
  }): Promise<void>;
  failMessage(messageId: string, failedAt: string, body?: string, talkingStonePassedTo?: string[]): Promise<void>;
  /** 服务重启兜底：将所有遗留 streaming/speaking 消息标记为 failed（重启后不存在活跃 agent），返回处理条数 */
  failInFlightMessages(failedAt: string, body: string): Promise<number>;
  /** 服务重启兜底：关闭不再有进行中消息的 open turn（配合 failInFlightMessages），返回关闭条数 */
  closeOrphanedTurns(closedAt: string): Promise<number>;
  /** 更新消息的 token 使用量（speak complete 后补充写入） */
  updateTokenUsage(messageId: string, contextTokens: number, contextTokensMax: number): Promise<void>;
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
  getMessageEventsByMessageIds(messageIds: string[]): Promise<MessageEvent[]>;
  getMaxEventSequenceNum(messageId: string): Promise<number>;

  // Message 全文搜索（FTS5）
  searchMessages(conversationId: string, query: string, limit?: number): Promise<Message[]>;

  /** F20260805rbrg：按 metadata.externalId 查重（招聘桥接去重用） */
  findByExternalId(externalId: string): Promise<Message | null>;

  // Turn 历史（含消息）
  getTurnHistory(conversationId: string, includeMessages?: boolean): Promise<TurnHistoryEntry[]>;

  // Key Resources（统一产物模型）
  linkResource(resource: LinkedResource): Promise<void>;
  getLinkedResources(conversationId: string, filters?: { status?: ArtifactStatus; resourceType?: string }): Promise<LinkedResource[]>;
  getLinkedResourceById(id: string): Promise<LinkedResource | null>;
  getLinkedResourcesByGroup(conversationId: string, groupId: string): Promise<LinkedResource[]>;
  updateResourceStatus(id: string, status: ArtifactStatus, statusChangedAtTurnNumber: number, supersededBy?: string): Promise<void>;
  supersedeLinkedResource(existingId: string, newResource: LinkedResource, statusChangedAtTurnNumber: number): Promise<void>;
  deleteLinkedResource(id: string): Promise<void>;
  flagResource(id: string, flagged: boolean): Promise<void>;

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
  /** 更新已读位置 */
  updateLastReadTurnNumber(
    conversationId: string,
    otterId: string,
    turnNumber: number,
  ): Promise<void>;
  /** 获取未读消息（从 lastReadTurnNumber 之后的消息） */
  getUnreadMessages(
    conversationId: string,
    otterId: string,
  ): Promise<Message[]>;

  // Web 用户已读状态（消息级，与 otter 的 turn 级已读独立）
  /** 获取 Web 用户的已读位置 */
  getUserReadState(
    conversationId: string,
    userId: string,
  ): Promise<{ lastReadSeq: number } | null>;
  /** 更新已读位置（只前进不后退：MAX(excluded, current)） */
  upsertUserReadState(
    conversationId: string,
    userId: string,
    lastReadSeq: number,
  ): Promise<void>;
  /** 第一条未读消息（seq > lastReadSeq，排除 streaming/speaking） */
  getFirstUnreadMessage(
    conversationId: string,
    userId: string,
  ): Promise<Message | null>;
  /** Web 用户未读消息计数 */
  getUnreadCount(
    conversationId: string,
    userId: string,
  ): Promise<number>;
  /** 会话最后一条消息（排除 streaming/speaking，用于列表预览） */
  getLastMessage(conversationId: string): Promise<Message | null>;

  // 会话列表批量查询（含未读计数 + last_message，替代 N+1）
  listConversationsWithMeta(
    userId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<Array<Conversation & {
    otterIds: string[];
    unreadCount: number;
    lastMessagePreview: string | null;
    lastMessageTs: string | null;
  }>>;
}
