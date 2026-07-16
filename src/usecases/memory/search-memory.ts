import type {
  MemoryEntry,
  RetrievalGranularity,
  DetailLevel,
} from "@entities/memory/memory-entry";
import type {
  MemoryRepository,
  SearchFilters,
  RetrievalSource,
  VecHit,
} from "./memory-repository";
import type { TerminologyRepository } from "./terminology-repository";
import type { EmbeddingGateway } from "./embedding-gateway";
import type { SearchEngine, RrfHit } from "./search-engine";
import { logger } from "@frameworks/logger";

/** snippet 降级截取长度（FTS5 highlight 不可用时） */
const SNIPPET_FALLBACK_LENGTH = 200;

export interface SearchQuery {
  query: string;
  limit: number;
  granularity?: RetrievalGranularity;
  conversationId?: string;
  /** 渐进式披露：控制返回内容的详细程度，默认 "snippet" */
  detailLevel?: DetailLevel;
  /** 指定库 key，不传则全库搜索 */
  library?: string;
}

export interface RetrievalResultEntry extends MemoryEntry {
  score: number;
  source: RetrievalSource;
  /** detail_level="snippet" 时的匹配片段 */
  snippet?: string;
}

export interface RetrievalResult {
  entries: RetrievalResultEntry[];
  total: number;
}

export class SearchMemory {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly embeddingGateway: EmbeddingGateway,
    private readonly searchEngine: SearchEngine,
    private readonly terminologyRepo?: TerminologyRepository,
  ) {}

  async search(query: SearchQuery): Promise<RetrievalResult> {
    /** 路由层：按 library 分发到各库的检索管道 */
    if (query.library === "conversation") {
      return this.searchConversation(query);
    }
    if (query.library === "terminology") {
      return this.searchTerminologyLibrary(query);
    }
    if (query.library) {
      throw new Error(`Unknown library: ${query.library}`);
    }
    /** 全库搜索：分别查各库，排名位置归一化混排 */
    return this.searchAllLibraries(query);
  }

  /** 对话库检索（原有逻辑） */
  private async searchConversation(query: SearchQuery): Promise<RetrievalResult> {
    return this.searchConversationInternal(query);
  }

  /** 术语库检索 */
  private async searchTerminologyLibrary(query: SearchQuery): Promise<RetrievalResult> {
    if (!this.terminologyRepo) {
      return { entries: [], total: 0 };
    }
    const results = await this.terminologyRepo.search(query.query, query.limit);
    const detailLevel = query.detailLevel ?? "snippet";
    const entries: RetrievalResultEntry[] = results.map((entry, rank) => {
      const fullContent = `[${entry.term}] ${entry.definition}${entry.context ? ` (${entry.context})` : ""}`;
      let content: string;
      let snippet: string | undefined;

      if (detailLevel === "summary") {
        /** summary：仅返回术语和简短定义 */
        content = `[${entry.term}] ${entry.definition.slice(0, 100)}${entry.definition.length > 100 ? "..." : ""}`;
        snippet = content;
      } else if (detailLevel === "snippet") {
        /** snippet：返回完整内容但标记为 snippet */
        content = fullContent;
        snippet = fullContent;
      } else {
        /** full：返回完整内容 */
        content = fullContent;
      }

      return {
        id: entry.id,
        layer: "key_info" as const,
        contentType: "key_fact" as const,
        sourceId: entry.id,
        sourceTable: "terminology_entries",
        conversationId: null,
        granularity: "coarse" as const,
        content,
        metadata: { term: entry.term, aliases: entry.aliases, category: entry.category, examples: entry.examples },
        createdAt: entry.createdAt,
        score: 1.0 / (1 + rank),
        source: "fts" as const,
        snippet,
      };
    });
    return { entries, total: entries.length };
  }

  /** 全库搜索：排名位置归一化混排 */
  private async searchAllLibraries(query: SearchQuery): Promise<RetrievalResult> {
    const allEntries: RetrievalResultEntry[] = [];

    /** 对话库 */
    const convResult = await this.searchConversationInternal(query);
    for (const [rank, entry] of convResult.entries.entries()) {
      allEntries.push({
        ...entry,
        normalizedScore: 1.0 / (1 + rank),
        library: "conversation",
        libraryPriority: 50,
      } as RetrievalResultEntry & { normalizedScore: number; library: string; libraryPriority: number });
    }

    /** 术语库 */
    if (this.terminologyRepo) {
      const termEntries = await this.searchTerminologyEntries(query);
      allEntries.push(...termEntries);
    }

    /** 按归一化分数降序混排，同分时按库优先级排列 */
    const typed = allEntries as (RetrievalResultEntry & { normalizedScore: number; libraryPriority: number })[];
    typed.sort((a, b) =>
      b.normalizedScore !== a.normalizedScore
        ? b.normalizedScore - a.normalizedScore
        : b.libraryPriority - a.libraryPriority,
    );

    const limit = query.limit ?? 10;
    const top = typed.slice(0, limit);
    /** 清理临时字段 */
    const entries: RetrievalResultEntry[] = top.map(({ ...rest }) => {
      const e = rest as RetrievalResultEntry & { normalizedScore?: number; library?: string; libraryPriority?: number };
      delete e.normalizedScore;
      delete e.library;
      delete e.libraryPriority;
      return e;
    });

    return { entries, total: entries.length };
  }

  /** 术语库搜索辅助方法（用于全库搜索混排） */
  private async searchTerminologyEntries(query: SearchQuery): Promise<(RetrievalResultEntry & { normalizedScore: number; library: string; libraryPriority: number })[]> {
    if (!this.terminologyRepo) return [];
    const results = await this.terminologyRepo.search(query.query, query.limit);
    const detailLevel = query.detailLevel ?? "snippet";
    return results.map((entry, rank) => {
      const fullContent = `[${entry.term}] ${entry.definition}${entry.context ? ` (${entry.context})` : ""}`;
      let content: string;
      let snippet: string | undefined;

      if (detailLevel === "summary") {
        content = `[${entry.term}] ${entry.definition.slice(0, 100)}${entry.definition.length > 100 ? "..." : ""}`;
        snippet = content;
      } else if (detailLevel === "snippet") {
        content = fullContent;
        snippet = fullContent;
      } else {
        content = fullContent;
      }

      return {
        id: entry.id,
        layer: "key_info" as const,
        contentType: "key_fact" as const,
        sourceId: entry.id,
        sourceTable: "terminology_entries",
        conversationId: null,
        granularity: "coarse" as const,
        content,
        metadata: { term: entry.term, aliases: entry.aliases, category: entry.category, examples: entry.examples },
        createdAt: entry.createdAt,
        score: 1.0 / (1 + rank),
        source: "fts" as const,
        snippet,
        normalizedScore: 1.0 / (1 + rank),
        library: "terminology",
        libraryPriority: 100,
      };
    });
  }

  private async searchConversationInternal(query: SearchQuery): Promise<RetrievalResult> {
    const detailLevel = query.detailLevel ?? "snippet";
    const filters: SearchFilters = {
      granularity: query.granularity,
      conversationId: query.conversationId,
    };

    /**
     * 1. FTS5 搜索。
     * snippet/summary 模式使用 highlight() 获取匹配片段；
     * full 模式使用普通搜索（不需要高亮）。
     */
    const useHighlight = detailLevel === "snippet" || detailLevel === "summary";
    let snippetMap: Map<string, string | undefined> | undefined;
    let rrfHits;

    if (useHighlight) {
      const ftsHits = await this.repo.searchFTSWithHighlight(query.query, filters);
      snippetMap = new Map(ftsHits.map((h) => [h.entryId, h.snippet]));
      const vecHits = await this.searchVec(query.query, filters, query.limit);
      rrfHits = this.searchEngine.rrfFusion(
        ftsHits.map((h) => ({ entryId: h.entryId, ftsRank: h.ftsRank, entry: h.entry })),
        vecHits,
      );
    } else {
      const ftsHits = await this.repo.searchFTS(query.query, filters);
      const vecHits = await this.searchVec(query.query, filters, query.limit);
      rrfHits = this.searchEngine.rrfFusion(ftsHits, vecHits);
    }

    /** 2. 重排 + 返回（传递 snippet 信息用于降级） */
    return this.rerankAndReturn(rrfHits, query.limit, detailLevel, snippetMap);
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
    detailLevel?: DetailLevel,
    snippetMap?: Map<string, string | undefined>,
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
        ...this.buildSnippet(h.entry, detailLevel, snippetMap),
      })),
      total: top.length,
    };
  }

  /** 根据 detail_level 构建返回内容 */
  private buildSnippet(
    entry: MemoryEntry,
    detailLevel?: DetailLevel,
    snippetMap?: Map<string, string | undefined>,
  ): { snippet?: string } {
    if (!detailLevel || detailLevel === "full") return {};

    /** 获取 FTS highlight 片段（vec-only 结果为 undefined） */
    const ftsSnippet = snippetMap?.get(entry.id);

    /** 降级：vec-only 结果截取 content 前 200 字符 */
    const snippet = ftsSnippet ?? entry.content.slice(0, SNIPPET_FALLBACK_LENGTH);

    if (detailLevel === "summary") {
      /** summary：取 snippet 的第一句（截取到首个句号/换行） */
      const firstSentence = snippet.match(/^[^\n。.！!？?]*[。.！!？?\n]?/)?.[0] ?? snippet;
      return { snippet: firstSentence };
    }

    return { snippet };
  }
}
