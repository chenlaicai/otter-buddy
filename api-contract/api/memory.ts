/** 检索来源（纯字符串联合，不依赖 usecases 层） */
export type RetrievalSource = "fts" | "vec" | "both";

/** 详细程度 */
export type DetailLevel = "summary" | "snippet" | "full";

/** 记忆条目 DTO */
export interface MemoryEntryDTO {
  id: string;
  layer: string;
  contentType: string;
  sourceId: string;
  sourceTable: string;
  conversationId: string | null;
  granularity: string;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  score?: number;
  source?: RetrievalSource;
  /** detail_level=snippet/summary 时的匹配片段 */
  snippet?: string;
}

/** 检索结果 DTO */
export interface SearchResultDTO {
  entries: MemoryEntryDTO[];
  total: number;
}

/** 记忆检索请求 query 参数 */
export interface SearchQueryDTO {
  query: string;
  limit?: number;
  layer?: string;
  granularity?: string;
  conversationId?: string;
  /** 渐进式披露：控制返回内容的详细程度 */
  detail_level?: DetailLevel;
}

/** 相似检索请求 DTO */
export interface SearchSimilarRequestDTO {
  memoryEntryId: string;
  limit?: number;
}

/** 标记记忆请求 DTO */
export interface FlagMemoryRequestDTO {
  flagged: boolean;
}
