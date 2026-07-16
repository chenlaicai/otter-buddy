/** 记忆层 */
export type MemoryLayer = "working" | "historical" | "key_info";

/**
 * 记忆层转换是否有效。
 * working ↔ historical 双向，key_info 单向到 historical。
 */
export function canTransitionMemoryLayer(from: MemoryLayer, to: MemoryLayer): boolean {
  if (from === to) return false;
  if (from === "working" && to === "historical") return true;
  if (from === "historical" && to === "working") return true;
  if (from === "key_info" && to === "historical") return true;
  return false;
}

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
