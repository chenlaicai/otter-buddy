import type {
  MemoryEntry,
  MemoryWeight,
  MemoryLayer,
  RetrievalGranularity,
} from "@entities/memory/memory-entry";

export interface SearchFilters {
  layer?: MemoryLayer;
  granularity?: RetrievalGranularity;
  conversationId?: string;
}

/** 检索来源标识 */
export type RetrievalSource = "fts" | "vec" | "both";

/** FTS5 全文检索命中 */
export interface FTSHit {
  entryId: string;
  ftsRank: number;
  entry: MemoryEntry;
}

/** 带 snippet 的 FTS5 命中（渐进式披露） */
export interface SnippetHit {
  entryId: string;
  ftsRank: number;
  entry: MemoryEntry;
  /** FTS5 highlight() 生成的匹配片段，vec0 结果为 undefined */
  snippet?: string;
}

/** vec0 向量检索命中 */
export interface VecHit {
  entryId: string;
  distance: number;
  entry: MemoryEntry;
}

export interface MemoryRepository {
  // 写入
  storeEntry(entry: MemoryEntry): Promise<void>;
  storeEmbedding(memoryEntryId: string, embedding: Float32Array): Promise<void>;
  // 查询
  getById(id: string): Promise<MemoryEntry | null>;
  getEmbedding(memoryEntryId: string): Promise<Float32Array | null>;
  getWeights(memoryEntryIds: string[]): Promise<MemoryWeight[]>;
  // 检索
  searchFTS(query: string, filters: SearchFilters): Promise<FTSHit[]>;
  /** FTS5 检索 + highlight() 生成 snippet（渐进式披露） */
  searchFTSWithHighlight(query: string, filters: SearchFilters): Promise<SnippetHit[]>;
  searchVec(
    embedding: Float32Array,
    limit: number,
    filters: SearchFilters,
  ): Promise<VecHit[]>;
  hasVecTable(): boolean;
  /** 按 ID 批量获取记忆条目（渐进式披露 get_memory_detail） */
  getDetails(ids: string[]): Promise<MemoryEntry[]>;
  // 更新
  incrementRetrievalCounts(memoryEntryIds: string[]): Promise<void>;
  flagMemory(memoryEntryId: string, flagged: boolean): Promise<void>;
  updateLayerByConversation(conversationId: string, from: MemoryLayer, to: MemoryLayer): Promise<void>;
}
