/** 对话状态 */
export type ConversationStatus = "active" | "completed" | "archived";

/** 对话实体（无对话树，独立实体） */
export interface Conversation {
  id: string;
  title: string;
  status: ConversationStatus;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
}

/** 轮次状态 */
export type TurnStatus = "open" | "closed";

/** 对话轮次（发言石轮次模型） */
export interface Turn {
  id: string;
  conversationId: string;
  turnNumber: number; // 1, 2, 3, ...（对话内自增）
  status: TurnStatus; // open = 等待发言者完成，closed = 全部完成
  createdAt: string;
  closedAt: string | null;
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
  linkedAtTurnNumber: number;
  statusChangedAtTurnNumber: number;
  groupId: string | null;
  supersededBy: string | null;
}

/** 附件值对象 */
export interface Attachment {
  type: string;
  url: string;
  name?: string;
}

/** 对话参与者状态（UA-4~UA-10 进场/退场机制） */
export type ParticipantStatus = "active" | "left";

/**
 * 对话参与者实体（UA-7 动态在场名单的唯一真相源）。
 *
 * - 初始参与者在 create() 时创建（joinedAtTurnId=null, joinedAtTurnNumber=0）
 * - 后进场者通过 join() 创建（joinedAtTurnId 指向当前 Turn）
 * - 退场时更新 leftAtTurnId/leftAtTurnNumber/status
 * - 每个 Otter 实例在一个对话中只进场/退场一次（UA-10）
 */
export interface ConversationParticipant {
  id: string;
  conversationId: string;
  otterId: string;
  joinedAtTurnId: string | null; // null 表示对话开始前已在场
  joinedAtTurnNumber: number; // 0 表示对话开始前已在场
  leftAtTurnId: string | null;
  leftAtTurnNumber: number | null;
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
 * 轮次是否仍在进行（接受发言者发言）
 */
export function isTurnActive(status: TurnStatus): boolean {
  return status === "open";
}

/**
 * 消息是否可以添加到该轮次。
 * 仅 open 状态的 Turn 可接受新消息。
 * 来源：UA-8 直接推论——每一轮发言者必须全部完成才进入下一轮
 */
export function canAddMessageToTurn(turnStatus: TurnStatus): boolean {
  return turnStatus === "open";
}

/**
 * 轮次是否可以关闭。
 * 当轮次内所有消息都到达终态时，可以关闭轮次。
 * allMessagesTerminal: 轮次内所有消息是否已到达终态（completed/failed）
 */
export function canCloseTurn(allMessagesTerminal: boolean): boolean {
  return allMessagesTerminal;
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
