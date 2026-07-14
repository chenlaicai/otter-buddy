/**
 * domain/memory 领域模型类型定义。
 *
 * 记忆系统管理混合检索引擎（FTS5 + vec0 + RRF + 权重重排）。
 * 三层记忆：working（工作记忆）/ historical（历史对话）/ key_info（关键信息）。
 */

// ===== 值对象 =====

export type MemoryLayer = "working" | "historical" | "key_info";
export type MemoryContentType =
  | "message"
  | "conversation_summary"
  | "key_fact"
  | "linked_resource";
export type RetrievalGranularity = "coarse" | "fine";
export type RetrievalSource = "fts" | "vec" | "both";

// ===== 实体 =====

export interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  contentType: MemoryContentType;
  sourceId: string;
  sourceTable: string;
  conversationId: string | null;
  treePath: string | null;
  granularity: RetrievalGranularity;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface MemoryWeight {
  memoryEntryId: string;
  retrievalCount: number;
  lastRetrievedAt: string | null;
  userFlagged: boolean;
}

// ===== 输入类型 =====

export interface MemoryEntryInput {
  layer: MemoryLayer;
  contentType: MemoryContentType;
  sourceId: string;
  sourceTable: string;
  conversationId?: string;
  treePath?: string;
  granularity: RetrievalGranularity;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SearchQuery {
  query: string;
  layer?: MemoryLayer;
  granularity?: RetrievalGranularity;
  conversationId?: string;
  /** 当前对话树路径，用于 task_relevance 计算 */
  treePath?: string;
  limit?: number;
}

// ===== 检索结果 =====

export interface RetrievalResult {
  entries: MemoryEntry[];
  scores: number[];
  /** 每条结果的检索来源 */
  sources: RetrievalSource[];
}

// ===== 内部类型（repository / search-engine 使用，不暴露到 Port） =====

export interface FTSHit {
  memoryEntryId: string;
  bm25Score: number;
  entry: MemoryEntry;
}

export interface VecHit {
  memoryEntryId: string;
  distance: number;
  entry: MemoryEntry;
}

export interface RrfHit {
  memoryEntryId: string;
  rrfScore: number;
  entry: MemoryEntry;
  source: RetrievalSource;
}

export interface ScoredHit {
  memoryEntryId: string;
  finalScore: number;
  entry: MemoryEntry;
  source: RetrievalSource;
}
