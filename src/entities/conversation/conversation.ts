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

/** 关键事实实体 */
export interface KeyFact {
  id: string;
  conversationId: string;
  content: string;
  category: string | null;
  userFlagged: boolean;
  createdBy: string;
  otterId: string | null;
  createdAt: string;
}

/** 链接资源实体 */
export interface LinkedResource {
  id: string;
  conversationId: string;
  resourceType: string;
  url: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
  linkedBy: string;
  otterId: string | null;
  autoLinked: boolean;
  createdAt: string;
}

/** 关键信息组合值对象 */
export interface KeyInfo {
  keyFacts: KeyFact[];
  linkedResources: LinkedResource[];
}

/** 附件值对象 */
export interface Attachment {
  type: string;
  url: string;
  name?: string;
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
