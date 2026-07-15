import type {
  MemoryEntry,
  MemoryLayer,
  RetrievalGranularity,
} from "@entities/memory/memory-entry";
import type {
  MemoryRepository,
  SearchFilters,
  RetrievalSource,
  VecHit,
} from "./memory-repository";
import type { EmbeddingGateway } from "./embedding-gateway";
import type { SearchEngine, RrfHit } from "./search-engine";
import { logger } from "@frameworks/logger";

export interface SearchQuery {
  query: string;
  limit: number;
  layer?: MemoryLayer;
  granularity?: RetrievalGranularity;
  conversationId?: string;
}

export interface RetrievalResult {
  entries: Array<MemoryEntry & { score: number; source: RetrievalSource }>;
  total: number;
}

export class SearchMemory {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly embeddingGateway: EmbeddingGateway,
    private readonly searchEngine: SearchEngine,
  ) {}

  async search(query: SearchQuery): Promise<RetrievalResult> {
    const filters: SearchFilters = {
      layer: query.layer,
      granularity: query.granularity,
      conversationId: query.conversationId,
    };

    /** 1. FTS5 搜索（始终可用） */
    const ftsHits = await this.repo.searchFTS(query.query, filters);

    /** 2. vec0 搜索（可能降级，D22） */
    const vecHits = await this.searchVec(query.query, filters, query.limit);

    /** 3. RRF 融合 */
    const rrfHits = this.searchEngine.rrfFusion(ftsHits, vecHits);

    /** 4. 重排 + 返回 */
    return this.rerankAndReturn(rrfHits, query.limit);
  }

  async searchSimilar(
    memoryEntryId: string,
    limit: number,
  ): Promise<RetrievalResult> {
    /** 1. 获取 embedding */
    const embedding = await this.repo.getEmbedding(memoryEntryId);
    if (!embedding) {
      return { entries: [], total: 0 };
    }

    /** 2. vec 搜索（limit+1 补偿自身匹配过滤） */
    const vecHits = await this.repo.searchVec(embedding, limit + 1, {});
    const filtered = vecHits.filter((h) => h.entryId !== memoryEntryId);

    /** 3. 单源 RRF + 重排 */
    const rrfHits = this.searchEngine.buildSingleSourceRrfHits(filtered);
    return this.rerankAndReturn(rrfHits, limit);
  }

  /** vec0 搜索（含降级逻辑，D22） */
  private async searchVec(
    query: string,
    filters: SearchFilters,
    limit: number,
  ): Promise<VecHit[]> {
    if (!this.repo.hasVecTable()) return [];
    try {
      const queryEmbedding = await this.embeddingGateway.embed(query);
      return this.repo.searchVec(queryEmbedding, limit, filters);
    } catch (err) {
      logger.warn(`Embedding search failed, falling back to FTS5 only: ${err}`);
      return [];
    }
  }

  /** RRF 融合后的结果重排 + 批量递增计数 + 组装返回值 */
  private async rerankAndReturn(
    rrfHits: Map<string, RrfHit>,
    limit: number,
  ): Promise<RetrievalResult> {
    const hitIds = Array.from(rrfHits.keys());
    if (hitIds.length === 0) {
      return { entries: [], total: 0 };
    }

    const weights = await this.repo.getWeights(hitIds);
    const weightMap = new Map(weights.map((w) => [w.memoryEntryId, w]));

    const scored = this.searchEngine.rerank(rrfHits, weightMap);
    scored.sort((a, b) => b.finalScore - a.finalScore);
    const top = scored.slice(0, limit);

    /** S15: 批量递增检索计数 */
    await this.repo.incrementRetrievalCounts(top.map((h) => h.entryId));

    return {
      entries: top.map((h) => ({
        ...h.entry,
        score: h.finalScore,
        source: h.source,
      })),
      total: top.length,
    };
  }
}
