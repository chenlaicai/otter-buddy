/** 记忆内容类型 */
export type MemoryContentType =
  | "message"
  | "conversation_summary"
  | "key_fact"
  | "linked_resource";

/** 检索粒度 */
export type RetrievalGranularity = "coarse" | "fine";

/** 渐进式披露 detail_level */
export type DetailLevel = "summary" | "snippet" | "full";

/** 记忆条目实体 */
export interface MemoryEntry {
  id: string;
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
