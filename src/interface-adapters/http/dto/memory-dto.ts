import type { MemoryEntry } from "@entities/memory/memory-entry";
import type {
  RetrievalSource,
  MemoryEntryDTO,
  SearchResultDTO,
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
  /**
   * #542：usecase 已按 detailLevel 完成 content 投影（summary=原文首句 / snippet=匹配窗口 /
   * full=全文），DTO 层直传——此前用 snippet 二次覆盖 content 会把 summary 首句重新替换成
   * FTS 窗口，重蹈「深匹配条目 content 失真」的覆辙（投影只做一次，语义归 usecase 层）。
   * detailLevel 参数随之移除（DTO 不再参与投影裁剪）。
   */
): MemoryEntryDTO {
  const content = entry.content;
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
