/**
 * 检索来源（纯字符串联合，不依赖 usecases 层）。
 * F20260811mrpy Part 1：扩展契约。
 * F20260812mrcq Part 3：收敛——删 keyword-fallback（用因已被 jieba 双表消解）和
 *   related-expand（重工程收益不明）。anchor + context-expand 由 F20260812mrcq 实施。
 */
export type RetrievalSource =
  | "fts"
  | "vec"
  | "both"
  | "anchor"
  | "context-expand";

/** 详细程度 */
export type DetailLevel = "summary" | "snippet" | "full";

/**
 * F20260811mrpy Part 1：vec 路径覆盖率（默认返回）。
 * F20260812mrcq Part 2 审视 m5：加 vecDisabled，消除 ratio=0 歧义。
 */
export interface VecCoverageDTO {
  total: number;
  withVec: number;
  ratio: number;
  /** F20260812mrcq Part 2: vec 路径运行时禁用（disableVec 清表后） */
  vecDisabled?: boolean;
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

/** #576（F20260901emps）：最近记忆列表（记忆搜索页初始态数据源） */
export interface RecentMemoryDTO {
  entries: MemoryEntryDTO[];
  total: number;
}
export interface SearchResultDTO {
  entries: MemoryEntryDTO[];
  total: number;
  vecCoverage: VecCoverageDTO;
  /** F20260812mrcq Part 2: 邻域扩展条目（仅 expand_context=true 时存在） */
  contextEntries?: MemoryEntryDTO[];
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
  /** F20260812mrcq Part 2: 开启邻域扩展（chunk ±1 / message 前后条） */
  expand_context?: boolean;
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
