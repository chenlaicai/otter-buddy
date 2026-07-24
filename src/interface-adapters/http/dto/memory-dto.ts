import type { MemoryEntry } from "@entities/memory/memory-entry";
import type { RetrievalSource } from "@contract/api/memory";
import type {
  MemoryEntryDTO,
  SearchResultDTO,
} from "@contract/api/memory";

export type { MemoryEntryDTO, SearchResultDTO, RetrievalSource };
export type { SearchQueryDTO, SearchSimilarRequestDTO, FlagMemoryRequestDTO, DetailLevel } from "@contract/api/memory";

export function toMemoryEntryDTO(
  entry: MemoryEntry & { userFlagged?: boolean },
  score?: number,
  source?: RetrievalSource,
  snippet?: string,
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
    snippet,
    ...(entry.userFlagged !== undefined && { userFlagged: entry.userFlagged }),
  };
}
