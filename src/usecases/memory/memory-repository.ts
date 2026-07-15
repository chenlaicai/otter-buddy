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
  getBySource(sourceTable: string, sourceId: string): Promise<MemoryEntry | null>;
  getEmbedding(memoryEntryId: string): Promise<Float32Array | null>;
  getWeights(memoryEntryIds: string[]): Promise<MemoryWeight[]>;
  // 检索
  searchFTS(query: string, filters: SearchFilters): Promise<FTSHit[]>;
  searchVec(
    embedding: Float32Array,
    limit: number,
    filters: SearchFilters,
  ): Promise<VecHit[]>;
  hasVecTable(): boolean;
  // 更新
  incrementRetrievalCounts(memoryEntryIds: string[]): Promise<void>;
  flagMemory(memoryEntryId: string, flagged: boolean): Promise<void>;
  updateLayerByConversation(
    conversationId: string,
    from: MemoryLayer,
    to: MemoryLayer,
  ): Promise<void>;
}
