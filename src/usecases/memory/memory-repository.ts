import type {
  MemoryEntry,
  MemoryWeight,
  MemoryLayer,
  MemoryContentType,
  RetrievalGranularity,
} from "@entities/memory/memory-entry";
import type { EmbedModelMeta } from "./embedding-gateway";

export interface SearchFilters {
  layer?: MemoryLayer;
  granularity?: RetrievalGranularity;
  conversationId?: string;
  /** F20260805rbrg：仅返回 createdAt >= 此时间戳（ISO string）的记录 */
  createdAfter?: string;
  /** F20260803fbit: 按 contentType 过滤（多选 IN 查询），支持"只搜 body"或"只搜 summary" */
  contentType?: MemoryContentType[];
}

/**
 * 检索来源标识。
 * F20260811mrop Part 1：扩展契约——为 anchor lookup / context expand 等新路径预留。
 * 当前实际产生的值仅 fts/vec/both，其余值由后续 P1 优化点（Anchor Lookup / Passage Context / Edges）填充。
 */
export type RetrievalSource =
  | "fts"
  | "vec"
  | "both"
  | "anchor"            // P1-1 Anchor Lookup 短路注入
  | "keyword-fallback"  // P2-5 候选
  | "context-expand"    // P1-2 Passage Context Window 邻域补充
  | "related-expand";   // P1-3 Edges 1-hop 图扩展

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

/** F20260811mrop Part 1：暗化条目（无 vec 索引的 memory entry） */
export interface DarkEntry {
  entryId: string;
  contentType: string;
  sourceId: string;
  createdAt: string;
}

export interface MemoryRepository {
  // 写入
  storeEntry(entry: MemoryEntry): Promise<void>;
  storeEmbedding(memoryEntryId: string, embedding: Float32Array): Promise<void>;
  /** F20260803mval: 按 source 删除记忆条目（upsert reindex 时清旧 entry，防 FTS 命中陈旧内容） */
  deleteBySource(sourceTable: string, sourceId: string): Promise<void>;
  /** F20260803mval: 按 source 原子替换（单事务内删旧+插新，防 upsert 中间失败丢数据，B2 修复） */
  replaceEntryBySource(entry: MemoryEntry): Promise<void>;
  /** F20260803chunk: 按 source 原子替换多条 entry（1:N，单事务删旧全部+插新 N 条），chunk 索引用 */
  replaceEntriesBySource(entries: MemoryEntry[]): Promise<void>;
  /** PR审视 S3-14: 按 source + contentType 删除（body 清空时清理旧 chunk entries） */
  deleteBySourceAndType(sourceTable: string, sourceId: string, contentType: MemoryContentType): Promise<void>;
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
  /** F20260811mrop Part 3：读取存储的 embedding 元信息 */
  getEmbeddingMeta(): Promise<Partial<EmbedModelMeta>>;
  /** F20260811mrop Part 3：写入/更新 embedding 元信息 */
  setEmbeddingMeta(meta: EmbedModelMeta): Promise<void>;
  /**
   * F20260811mrop Part 1：扫描无 vec 索引的暗化条目（fire-and-forget 失败导致）。
   * 用 NOT EXISTS 子查询规避 vec0 虚拟表 anti-join 限制。
   */
  scanDarkEntries(): Promise<{ entries: DarkEntry[]; total: number }>;
  /**
   * F20260811mrop Part 1：批量查询 entry 是否有 vec 索引（vecCoverage 计算用）。
   * 返回 Map<entryId, hasVec>。vec 表不可用时所有 entry 返回 false。
   */
  hasEmbeddings(entryIds: string[]): Promise<Map<string, boolean>>;
}
