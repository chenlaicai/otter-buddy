/** 对话状态 */
export type ConversationStatus = "active" | "completed" | "archived";

/** 对话实体（无对话树，独立实体） */
export interface Conversation {
  id: string;
  title: string;
  status: ConversationStatus;
  summary: string | null;
  pinned: boolean;
  /** F20260920imax：对话类别——assistant = IM 助理自动开户（schema 字段取代 title 前缀约定） */
  kind: "normal" | "assistant";
  /** 工作区相对路径（相对于 dataDir），null 表示无工作区（旧数据） */
  workspaceDir: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
}

/** F20260920imax：测试/存量构造便捷类型——kind 可缺省（normal 默认）。
 *  实体接口 Conversation.kind 仍为必填，避免读端到处判 undefined；
 *  写端（create/insert）用 Conversations 兼容形式收敛可逃逸的可选性 */
export type ConversationInput = Omit<Conversation, "kind"> & { kind?: "normal" | "assistant" };

/** 归一化：缺省 kind 补 normal（构造入口统一，防止 undefined 流入写库路径） */
export function normalizeConversationInput(input: ConversationInput): Conversation {
  return { ...input, kind: input.kind ?? "normal" };
}

/** 产物生命周期状态 */
export type ArtifactStatus = "active" | "superseded" | "archived";

/** 链接资源实体（统一产物模型，resourceType="fact" 为文本类事实） */
export interface LinkedResource {
  id: string;
  conversationId: string;
  resourceType: string;
  url: string | null;
  title: string | null;
  content: string | null;
  category: string | null;
  userFlagged: boolean;
  metadata: Record<string, unknown> | null;
  linkedBy: string;
  otterId: string | null;
  autoLinked: boolean;
  createdAt: string;
  status: ArtifactStatus;
  groupId: string | null;
  supersededBy: string | null;
}

/** 对话参与者状态（UA-4~UA-10 进场/退场机制） */
export type ParticipantStatus = "active" | "left";

/**
 * 对话参与者实体（UA-7 动态在场名单的唯一真相源）。
 *
 * - 初始参与者在 create() 时创建，后进场者通过 join() 创建
 * - 退场时更新 leftAt/status
 * - 每个 Otter 实例在一个对话中只进场/退场一次（UA-10）
 * - F20260920trrt：turn 戳字段（joinedAtTurnId/lastActiveTurnNumber 等）随 turn 系统退役；
 *   已读游标唯一刻度 = lastReadSeq（F20260902sgp2 S4c）
 */
export interface ConversationParticipant {
  id: string;
  conversationId: string;
  otterId: string;
  status: ParticipantStatus;
  createdAt: string;
  leftAt: string | null;
}

/**
 * 对话状态转换：active -> completed
 * 来源：旧 adapter.ts complete() 方法中的状态校验
 */
export function canCompleteConversation(status: ConversationStatus): boolean {
  return status === "active";
}

/**
 * 对话状态转换：completed -> archived
 * 来源：旧 adapter.ts archive() 方法中的状态校验
 */
export function canArchiveConversation(status: ConversationStatus): boolean {
  return status === "completed";
}

/**
 * Otter 是否可以进场（UA-10）。
 * 无已有参与记录时可以进场（每个 Otter 实例只进场一次）。
 */
export function canJoinConversation(
  existingParticipant: ConversationParticipant | null,
): boolean {
  return existingParticipant === null;
}

/**
 * Otter 是否可以退场（UA-7）。
 * 当前状态为 active 时可以退场。
 */
export function canLeaveConversation(
  participant: ConversationParticipant | null,
): boolean {
  return participant !== null && participant.status === "active";
}

/**
 * 产物状态转换校验。
 * active -> superseded | archived
 * superseded -> archived
 * archived 为终态，不可转换。
 */
export function canTransitionArtifactStatus(
  from: ArtifactStatus,
  to: ArtifactStatus,
): boolean {
  if (from === to) return false;
  if (from === "archived") return false;
  if (from === "active") return to === "superseded" || to === "archived";
  if (from === "superseded") return to === "archived";
  return false;
}

/** 产物是否处于活跃状态 */
export function isArtifactActive(status: ArtifactStatus): boolean {
  return status === "active";
}

/** 产物是否可见（active + superseded 可见，archived 不可见） */
export function isArtifactVisible(status: ArtifactStatus): boolean {
  return status === "active" || status === "superseded";
}

/** 产物分组值对象 */
export interface ArtifactGroup {
  groupId: string;
  resources: LinkedResource[];
  latestActive: LinkedResource | null;
}

/** 产物索引值对象 */
export interface ArtifactIndex {
  ungrouped: LinkedResource[];
  groups: ArtifactGroup[];
}
