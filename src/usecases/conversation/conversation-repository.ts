import type {
  ArtifactStatus,
  Conversation,
  ConversationStatus,
  LinkedResource,
  ConversationParticipant,
} from "@entities/conversation/conversation";

export type ListConversationsFilter = {
  limit?: number;
  offset?: number;
  search?: string;
  /** F20260922cgrp：按状态过滤（弱状态两态：active | archived）；缺省 = 仅 active（归档对话移入独立空间） */
  status?: ConversationStatus;
  /** F20260922cgrp：按类别过滤（assistant = IM 助理；normal = 普通对话）；缺省不过滤 */
  kind?: "normal" | "assistant";
  /** F20260922cgrp delta：按置顶过滤（false = 仅非置顶——普通区分页不含置顶，计数口径对齐）；缺省不过滤 */
  pinned?: boolean;
};

export type ConversationListItem = Conversation & {
  otterIds: string[];
  unreadCount: number;
  lastMessagePreview: string | null;
  lastMessageTs: string | null;
  /** 实时活动状态（派生字段） */
  activityStatus: 'processing' | 'awaiting_user' | 'idle';
};

export type ConversationListResult = {
  items: ConversationListItem[];
  /** 满足过滤条件的总数（不含 limit/offset），供前端页码跳转 */
  total: number;
};

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
  /** F20260918imas：收篇摘要落库（助理对话软轮换用） */
  updateSummary(id: string, summary: string): Promise<void>;
  getAllIds(options?: { limit?: number; offset?: number }): Promise<string[]>;
  updatePinned(id: string, pinned: boolean): Promise<void>;

  // 对话参与者
  getOtterIds(conversationId: string): Promise<string[]>;

  // F20260920trrt：闲置预警新口径（发言 seq 差 + 时间护栏）读时聚合查询。
  // 可选接口：测试桩可不实现（未注入时预警降级为无，不阻断主流程）。
  getMaxEntrySeq(conversationId: string): number | Promise<number>;
  getLastSpeakBySender(conversationId: string): Map<string, { seq: number; createdAt: string }> | Promise<Map<string, { seq: number; createdAt: string }>>;
  getLastInvokeStartedAtByOtter(conversationId: string): Map<string, string> | Promise<Map<string, string>>;

  // Key Resources（统一产物模型）
  linkResource(resource: LinkedResource): Promise<void>;
  getLinkedResources(conversationId: string, filters?: { status?: ArtifactStatus; resourceType?: string }): Promise<LinkedResource[]>;
  getLinkedResourceById(id: string): Promise<LinkedResource | null>;
  getLinkedResourcesByGroup(conversationId: string, groupId: string): Promise<LinkedResource[]>;
  updateResourceStatus(id: string, status: ArtifactStatus, supersededBy?: string): Promise<void>;
  supersedeLinkedResource(existingId: string, newResource: LinkedResource): Promise<void>;
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
  updateParticipantLeave(participantId: string, leftAt: string): Promise<void>;
  /** F20260902sgp2 S4c：游标 seq 刻度（turn 刻度列已随 F20260920trrt 退役——此列是唯一已读游标）。
   *  可选：未实现的仓储（测试桩/嵌入方）跳过即可。 */
  updateLastReadSeq?(
    conversationId: string,
    otterId: string,
    seq: number,
  ): void;
  /** #775：seq 刻度存量回填（一次性，启动时调用）。实体方法：sqlite 实现专用，
   *  未实现的仓储（测试桩）不需要——调用方用 `'backfillLastReadSeq' in repo` 防御。 */
  backfillLastReadSeq?(): number;
  /** 标记参与者已离开（dissolve_otter 顺带修：不创建系统消息） */
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
  // F20260922cgrp：返回 { items, total }——total 供前端分组分页页码跳转
  listConversationsWithMeta(
    userId: string,
    options?: ListConversationsFilter,
  ): Promise<ConversationListResult>;
}
