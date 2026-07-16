import type { MemoryEntry } from "@entities/memory/memory-entry";
import type { RetrievalSource } from "@usecases/memory/memory-repository";

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

export function toMemoryEntryDTO(
  entry: MemoryEntry,
  score?: number,
  source?: RetrievalSource,
): MemoryEntryDTO {
  return {
    id: entry.id,
    layer: entry.layer,
    contentType: entry.contentType,
    sourceId: entry.sourceId,
    sourceTable: entry.sourceTable,
    conversationId: entry.conversationId,
    granularity: entry.granularity,
    content: entry.content,
    metadata: entry.metadata,
    createdAt: entry.createdAt,
    score,
    source,
  };
}
