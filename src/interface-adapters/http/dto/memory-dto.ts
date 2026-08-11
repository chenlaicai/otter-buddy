import type { MemoryEntry } from "@entities/memory/memory-entry";
import type {
  RetrievalSource,
  MemoryEntryDTO,
  SearchResultDTO,
  DetailLevel,
  RetrievalDebugInfoDTO,
} from "@contract/api/memory";

export type { MemoryEntryDTO, SearchResultDTO, RetrievalSource };
export type {
  SearchQueryDTO, SearchSimilarRequestDTO, FlagMemoryRequestDTO,
  DetailLevel, VecCoverageDTO, RetrievalDebugInfoDTO,
} from "@contract/api/memory";

export function toMemoryEntryDTO(
  entry: MemoryEntry & {
    userFlagged?: boolean;
    debug?: RetrievalDebugInfoDTO;
    drillDown?: { tool: string; params: Record<string, unknown> };
  },
  score?: number,
  source?: RetrievalSource,
  snippet?: string,
  /** 渐进式披露：非 full 时裁剪 content 避免上下文暴涨 */
  detailLevel?: DetailLevel,
): MemoryEntryDTO {
  const content = detailLevel && detailLevel !== "full" && snippet
    ? snippet
    : entry.content;
  return {
    id: entry.id,
    layer: entry.layer,
    contentType: entry.contentType,
    sourceId: entry.sourceId,
    sourceTable: entry.sourceTable,
    conversationId: entry.conversationId,
    granularity: entry.granularity,
    content,
    metadata: entry.metadata,
    createdAt: entry.createdAt,
    score,
    source,
    snippet,
    ...(entry.userFlagged !== undefined && { userFlagged: entry.userFlagged }),
    ...(entry.debug !== undefined && { debug: entry.debug }),
    ...(entry.drillDown !== undefined && { drillDown: entry.drillDown }),
  };
}
