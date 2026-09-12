import type {
  ArtifactStatus,
  Conversation,
  ConversationStatus,
  Turn,
  LinkedResource,
  ConversationParticipant,
} from "@entities/conversation/conversation";

/** Turn 历史条目（含该 Turn 下的 entries——由查询侧自行装配） */
export interface TurnHistoryEntry {
  turn: Turn;
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

  // Turn 管理（F20260910ctlv 批4c：消息生命周期/查询接口随 messages 表 drop 退役，时间线读写走 EntryRepository）
  createTurn(turn: Turn): Promise<void>;
  getActiveTurn(conversationId: string): Promise<Turn | null>;
  /** 按 id 查 turn（不论 status，用于 markBatchRead 在 turn 关闭后反查 turn_number） */
  getTurnById(turnId: string): Promise<Turn | null>;
  closeTurn(turnId: string, closedAt: string): Promise<void>;
  getMaxTurnNumber(conversationId: string): Promise<number>;

  /** 服务重启兜底：关闭无进行中 invoke 的 open turn，返回关闭条数 */
  closeOrphanedTurns(closedAt: string): Promise<number>;

  // Turn 历史（骨架；entries 由调用方经 EntryRepository.getEntriesByTurnId 装配）
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

  // Web 用户已读状态（entries seq 刻度，与 otter 的 turn 级已读独立）
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
  /** Web 用户未读条目计数（speak/system entries，messages 表退役后以 entries 计） */
  getUnreadCount(
    conversationId: string,
    userId: string,
  ): Promise<number>;

  // 会话列表批量查询（含未读计数 + 最后一条 entry 预览，替代 N+1）
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
