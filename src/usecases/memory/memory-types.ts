/**
 * MemoryRepository 三分（E）共享类型。
 *
 * 从 memory-repository.ts 提取，消除 memory-reader.ts 对 memory-repository.ts 的反向依赖。
 * SearchFilters / FTSHit / SnippetHit / VecHit / DarkEntry / RetrievalSource 被
 * MemoryReader、SearchMemory、SearchEngine、ScanDarkEntries 等多处引用。
 */

import type {
  MemoryEntry,
  MemoryLayer,
  MemoryContentType,
  RetrievalGranularity,
} from "@entities/memory/memory-entry";

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
 * F20260811mrpy Part 1：扩展契约为多种检索路径预留。
 * F20260812mrcq Part 3：收敛——删 keyword-fallback（用因已被 jieba 双表消解）和
 *   related-expand（重工程收益不明）。保留 anchor + context-expand 由 F20260812mrcq 实施。
 */
export type RetrievalSource =
  | "fts"
  | "vec"
  | "both"
  | "anchor"            // F20260812mrcq Part 3：F/R ID 子串提取 + 主键直查短路注入
  | "context-expand";   // F20260812mrcq Part 2：邻域扩展（chunk ±1 / message 前后条）

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

/** F20260811mrpy Part 1：暗化条目（无 vec 索引的 memory entry） */
export interface DarkEntry {
  entryId: string;
  contentType: string;
  sourceId: string;
  createdAt: string;
}
