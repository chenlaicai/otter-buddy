/**
 * 检索来源（纯字符串联合，不依赖 usecases 层）。
 * F20260811mrpy Part 1：扩展契约，预留 anchor/context-expand 等新路径值（当前实际产生的仅 fts/vec/both）。
 */
export type RetrievalSource =
  | "fts"
  | "vec"
  | "both"
  | "anchor"
  | "keyword-fallback"
  | "context-expand"
  | "related-expand";

/** 详细程度 */
export type DetailLevel = "summary" | "snippet" | "full";

/** F20260811mrpy Part 1：vec 路径覆盖率（默认返回） */
export interface VecCoverageDTO {
  total: number;
  withVec: number;
  ratio: number;
}

/** F20260811mrpy Part 1：debug 模式注入的中间分值 */
export interface RetrievalDebugInfoDTO {
  rrfScore: number;
  finalScore: number;
  timeDecay: number;
  frequencyBoost: number;
  multiHitCount?: number;
}

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
  snippet?: string;
  userFlagged?: boolean;
  debug?: RetrievalDebugInfoDTO;
  drillDown?: { tool: string; params: Record<string, unknown> };
}

/** 检索结果 DTO */
export interface SearchResultDTO {
  entries: MemoryEntryDTO[];
  total: number;
  vecCoverage: VecCoverageDTO;
}

/** 记忆检索请求 query 参数 */
export interface SearchQueryDTO {
  query: string;
  limit?: number;
  layer?: string;
  granularity?: string;
  conversationId?: string;
  detail_level?: DetailLevel;
  library?: string;
  debug?: boolean;
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
