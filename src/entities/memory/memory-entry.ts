/** 记忆层 */
export type MemoryLayer = "working" | "historical" | "key_info";

/** 记忆内容类型 */
export type MemoryContentType =
  | "message"
  | "conversation_summary"
  | "key_fact"
  | "linked_resource";

/** 检索粒度 */
export type RetrievalGranularity = "coarse" | "fine";

/** 记忆条目实体 */
export interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  contentType: MemoryContentType;
  sourceId: string;
  sourceTable: string;
  conversationId: string | null;
  granularity: RetrievalGranularity;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** 记忆权重实体 */
export interface MemoryWeight {
  memoryEntryId: string;
  retrievalCount: number;
  lastRetrievedAt: string | null;
  userFlagged: boolean;
}

/**
 * 记忆层转换是否有效。
 * working -> historical：有效（session 归档时工作记忆转历史）
 * 其他转换：无效
 * 来源：新增不变量，基于业务语义（旧 adapter updateLayerByConversation() 直接调用 repo 无校验）
 */
export function canTransitionMemoryLayer(from: MemoryLayer, to: MemoryLayer): boolean {
  return from === "working" && to === "historical";
}
