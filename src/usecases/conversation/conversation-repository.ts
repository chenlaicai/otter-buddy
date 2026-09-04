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
  MessageSegment,
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
  /** 按 id 查 turn（不论 status，用于 markBatchRead 在 turn 关闭后反查 turn_number） */
  getTurnById(turnId: string): Promise<Turn | null>;
  closeTurn(turnId: string, closedAt: string): Promise<void>;
  getMaxTurnNumber(conversationId: string): Promise<number>;
  getMessagesByTurnId(turnId: string): Promise<Message[]>;

  // Message 生命周期
  createCompletedMessage(message: Message): Promise<void>;
  createStreamingMessage(message: Message): Promise<void>;
  /** 开始发言（yield 交棒）：streaming → speaking，设置发言石目标；body 可选（拆分后内容由 speak 的 appendSegment 落库） */
  startSpeaking(messageId: string, body: string | undefined, talkingStonePassedTo: string[], signalLevel?: string | null, signalMeta?: string | null): Promise<void>;
  completeMessage(input: {
    messageId: string;
    talkingStonePassedTo: string[];
    completedAt: string;
    contextTokens?: number;
    contextTokensMax?: number;
  }): Promise<void>;
  failMessage(messageId: string, failedAt: string, body?: string, talkingStonePassedTo?: string[]): Promise<void>;
  /** 服务重启兜底：将所有遗留 streaming/speaking 消息标记为 failed，插入系统提示 segment，返回处理条数。
   *  F20260826rsme：skipNoticeIds 内的消息只置 failed 不插 notice（恢复流程会重置回 streaming 续写，
   *  notice 会污染续写内容）；其余消息保留现状语义。 */
  failInFlightMessages(failedAt: string, noticeBody: string, skipNoticeIds?: ReadonlySet<string>): Promise<number>;
  /** 服务重启兜底：关闭不再有进行中消息的 open turn（配合 failInFlightMessages），返回关闭条数 */
  closeOrphanedTurns(closedAt: string): Promise<number>;
  /** 重置 failed 消息为 streaming（yield 重试专用）。默认清空 segments。preserveSegments=true 时保留 segments（no_yield 重试专用：speak 内容有效，不应被删除）。status 非 failed 时抛 DomainError。 */
  // F20260821fix: no_yield 重试时保留 segments（speak 内容有效，不应被删除）
  resetForStreaming(messageId: string, turnId: string, preserveSegments?: boolean): Promise<void>;

  // ── 重启自动恢复队列（F20260826rsme）──
  /** 原子守卫：为中断消息登记恢复资格。INSERT OR IGNORE 后 UPDATE attempts+1 WHERE attempts<上限，
   *  返回是否成功获得资格（二次重启时 attempts 已满 → false → 走现状 fail+notice，防循环恢复）。 */
  claimResume(messageId: string, conversationId: string, otterId: string, now: string): Promise<boolean>;
  /** F20260826rsme：指定 senderType 的最新消息（恢复前并发窗口检查：窗口内有新 user 消息则跳过恢复） */
  getLastMessageBySenderType(conversationId: string, senderType: "user" | "otter" | "system"): Promise<Message | null>;
  /** F20260826rsme：遗留的 otter streaming/speaking 消息（含 conversationId/senderId），恢复资格判定用 */
  listInFlightOtterMessages(): Promise<Array<{ id: string; conversationId: string; senderId: string }>>;
  /** 查询待恢复记录（status=pending），按 created_at 升序 */
  getPendingResumes(): Promise<Array<{ messageId: string; conversationId: string; otterId: string }>>;
  /** 恢复结果流转：done（成功）| exhausted（超限/失败，不再重试） */
  updateResumeStatus(messageId: string, status: "done" | "exhausted", now: string): Promise<void>;
  /** 更新消息的 token 使用量（yield complete 后补充写入） */
  updateTokenUsage(messageId: string, contextTokens: number, contextTokensMax: number): Promise<void>;
  /** 中止消息：streaming -> aborted（body + talkingStonePassedTo 同一事务写入） */
  abortMessage(
    messageId: string,
    body: string,
    talkingStonePassedTo: string[],
    abortedAt: string,
  ): Promise<void>;

  // Message Segments
  /** 追加一条 speak 片段到消息，自动更新 FTS */
  appendSegment(messageId: string, body: string): Promise<MessageSegment>;
  /** 获取消息的所有片段（按 sequence_num 排序） */
  getSegments(messageId: string): Promise<MessageSegment[]>;
  getMaxSequenceNum(conversationId: string): Promise<number>;

  // Message 查询
  getMessageById(id: string): Promise<Message | null>;
  getMessages(
    conversationId: string,
    options: GetMessagesOptions,
  ): Promise<Message[]>;
  getMessagesBefore(messageId: string, count: number): Promise<Message[]>;
  getMessagesAfter(messageId: string, count: number): Promise<Message[]>;
  /** #642: 获取锚点后的最近 N 条消息（DESC），用于检测链末尾是否卡在429循环 */
  getLatestMessagesAfter(messageId: string, count: number): Promise<Message[]>;

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
  /** F20260902sgp2 S4c：游标 seq 双写（新刻度；旧 turn 刻度保留为回滚面）。
   *  可选：双写是 S4c 渐进语义，未实现的仓储（测试桩/嵌入方）跳过即可。 */
  updateLastReadSeq?(
    conversationId: string,
    otterId: string,
    seq: number,
  ): void;
  /** #775：seq 刻度存量回填（一次性，启动时调用）。实体方法：sqlite 实现专用，
   *  未实现的仓储（测试桩）不需要——调用方用 `'backfillLastReadSeq' in repo` 防御。 */
  backfillLastReadSeq?(): number;
  updateLastReadTurnNumber(
    conversationId: string,
    otterId: string,
    turnNumber: number,
  ): Promise<void>;
  /** F20260819idnw：更新最后活跃轮次（小獭发言时） */
  updateLastActiveTurnNumber(
    conversationId: string,
    otterId: string,
    turnNumber: number,
  ): Promise<void>;
  /** 标记参与者已离开（dissolve_otter 顺带修：不要求 active turn，不创建系统消息） */
  markParticipantLeft(conversationId: string, otterId: string): Promise<void>;
  /** 获取未读消息（从 lastReadTurnNumber 之后的消息） */
  getUnreadMessages(
    conversationId: string,
    otterId: string,
  ): Promise<Message[]>;
  /** 获取指定 sender 在对话中的最新消息（markBatchRead rejected 路径：invoke 失败但消息已 start） */
  getLastMessageBySender(
    conversationId: string,
    senderId: string,
  ): Promise<Message | null>;

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
    /** 实时活动状态（派生字段） */
    activityStatus: 'processing' | 'awaiting_user' | 'idle';
  }>>;
}
