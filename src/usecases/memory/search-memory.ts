/* eslint-disable max-lines -- F20260812mrcq 加 anchor/context-expand 后超 450 行 */
import type {
  MemoryEntry,
  MemoryLayer,
  MemoryContentType,
  RetrievalGranularity,
  DetailLevel,
} from "@entities/memory/memory-entry";
import { DomainError } from "@entities/errors";
import type {
  MemoryRepository,
  SearchFilters,
  RetrievalSource,
  VecHit,
} from "./memory-repository";
import type { TerminologyRepository } from "./terminology-repository";
import type { EmbeddingGateway } from "./embedding-gateway";
import type { SearchEngine, RrfHit, ScoredHit } from "./search-engine";
import type { Logger } from "@usecases/ports/logger";

/** snippet 降级截取长度（FTS5 highlight 不可用时） */
const SNIPPET_FALLBACK_LENGTH = 200;

/**
 * F20260812mrcq Part 3：F/R 文档 ID anchor 正则。
 * 子串提取（非全匹配）——支持 "F20260812mrcq 召回优化" 这种 "ID + 限定词" 模式。
 * \b 词边界防 "F20260812mrcqextra" 误匹配。4-6 位后缀兼容历史（推荐 4 位）。
 */
const ANCHOR_PATTERN = /\b([FR])\d{8}[a-z0-9]{4,6}\b/i;

export interface SearchQuery {
  query: string;
  limit: number;
  granularity?: RetrievalGranularity;
  conversationId?: string;
  /** 渐进式披露：控制返回内容的详细程度，默认 "snippet" */
  detailLevel?: DetailLevel;
  /** 指定库 key，不传则全库搜索 */
  library?: string;
  /** 按记忆层过滤（working/historical/document） */
  layer?: MemoryLayer;
  /** F20260805rbrg：仅返回 createdAt >= 此时间戳（ISO string）的记录 */
  createdAfter?: string;
  /** F20260803fbit: 按 contentType 过滤（多选），支持"只搜 body"或"只搜 summary" */
  contentType?: MemoryContentType[];
  /**
   * F20260811mrpy Part 1：开启时注入中间分值（rrfScore/timeDecay/frequencyBoost/multiHitCount）。
   * 默认关闭避免 token 膨胀。
   */
  debug?: boolean;
  /**
   * F20260812mrcq Part 2：开启时对命中条目扩展邻域（chunk ±1 / message 前后条），
   * 结果放在 contextEntries 字段（不混入 entries，避免评分断层）。
   * summary / fact 等无邻域结构的 contentType 不扩展。
   */
  expandContext?: boolean;
}

/** F20260811mrpy Part 1：debug=true 时注入的中间分值（召回诊断用） */
export interface RetrievalDebugInfo {
  rrfScore: number;
  finalScore: number;
  timeDecay: number;
  frequencyBoost: number;
  multiHitCount?: number;
}

export interface RetrievalResultEntry extends MemoryEntry {
  score: number;
  source: RetrievalSource;
  /** detail_level="snippet" 时的匹配片段 */
  snippet?: string;
  /** 用户标记（检索路径从 MemoryWeight 带出） */
  userFlagged?: boolean;
  /** F20260811mrpy Part 1：debug=true 时注入的中间分值 */
  debug?: RetrievalDebugInfo;
  /**
   * F20260811mrpy Part 2：detail_level != "full" 时填充，告知调用方用什么工具拿全文。
   * 形如 { tool: "get_memory_detail", params: { id } }
   */
  drillDown?: { tool: string; params: Record<string, unknown> };
}

/**
 * F20260811mrpy Part 1：vec 路径覆盖率（默认返回）。
 * ratio<1.0 说明有暗化条目（fire-and-forget 失败导致无 vec）。
 *
 * F20260812mrcq Part 2 审视 m5：加 vecDisabled 字段，消除 ratio=0 歧义
 * （空结果 vs vec 路径不可用）。
 */
export interface VecCoverage {
  total: number;
  withVec: number;
  ratio: number;
  /** F20260812mrcq Part 2: vec 路径运行时禁用（disableVec 清表后），消费方区分"无结果"vs"vec 不可用" */
  vecDisabled?: boolean;
}

export interface RetrievalResult {
  entries: RetrievalResultEntry[];
  total: number;
  /** F20260811mrpy Part 1：默认返回（不加 debug 参数也有） */
  vecCoverage: VecCoverage;
  /**
   * F20260812mrcq Part 2：邻域扩展条目（仅 expandContext=true 时存在）。
   * 独立于 entries，不参与 RRF 排序，source='context-expand'。
   * agent 应理解这是命中条目的"上下文补充"而非独立检索结果。
   */
  contextEntries?: RetrievalResultEntry[];
}

export class SearchMemory {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly embeddingGateway: EmbeddingGateway,
    private readonly searchEngine: SearchEngine,
    private readonly logger: Logger,
    private readonly terminologyRepo?: TerminologyRepository,
  ) {}

  async search(query: SearchQuery): Promise<RetrievalResult> {
    /**
     * F20260812mrcq Part 3: anchor 短路（仅 conversation / 全库，terminology 库跳过）。
     * 命中 F/R ID 时短路注入顶格，剩余 query 走 RRF。
     */
    if (query.library !== "terminology") {
      const anchorResult = await this.tryAnchorShortCircuit(query);
      if (anchorResult) {
        // F20260812mrcq Part 2: anchor 命中后也做邻域扩展（若 anchor 是 chunk）
        if (query.expandContext && query.detailLevel !== "full") {
          const ctx = await this.expandContextForEntries(anchorResult.entries);
          if (ctx.length > 0) anchorResult.contextEntries = ctx;
        }
        return anchorResult;
      }
    }

    /** 路由层：按 library 分发到各库的检索管道 */
    let result: RetrievalResult;
    if (query.library === "conversation") {
      result = await this.searchConversation(query);
    } else if (query.library === "terminology") {
      // terminology 库无 chunk/message 结构，不扩展
      return this.searchTerminologyLibrary(query);
    } else if (query.library) {
      throw new DomainError(`Unknown library: ${query.library}`, "validation");
    } else {
      result = await this.searchAllLibraries(query);
    }

    // F20260812mrcq Part 2: 邻域扩展（仅 chunk / message，summary/fact no-op）
    if (query.expandContext && query.detailLevel !== "full") {
      const ctx = await this.expandContextForEntries(result.entries);
      if (ctx.length > 0) result.contextEntries = ctx;
    }
    return result;
  }

  /**
   * F20260812mrcq Part 3: anchor 短路。
   * - 子串提取 F/R ID（支持 "ID + 其他词" 模式）
   * - URL 编码兜底（浏览器粘贴场景）
   * - ID 不存在 → return null（让上层走 RRF，ID 作为 keyword 进 FTS）
   * - ID 存在 → 顶格注入 + 剩余 query 走 RRF
   */
  private async tryAnchorShortCircuit(query: SearchQuery): Promise<RetrievalResult | null> {
    let queryString = query.query;
    try {
      queryString = decodeURIComponent(queryString);  // 审视 m6: URL 编码兜底
    } catch {
      // decodeURIComponent 遇到无效 escape 会抛错，原样使用
    }
    const match = queryString.match(ANCHOR_PATTERN);
    if (!match) return null;

    // 审视二轮 M3: anchorId 归一化为文档命名约定的小写后缀（DB source_id 大小写敏感）
    const rawId = match[0];
    const anchorId = rawId[0].toUpperCase() + rawId.slice(1).toLowerCase();
    const isFeature = rawId[0].toUpperCase() === "F";
    const preferredContentType = isFeature ? "feature" : "research";
    // 优先 summary（coarse 粒度信息密度高），fallback 到任意 contentType
    const anchorEntry =
      (await this.repo.getBySourceId(anchorId, preferredContentType as MemoryContentType))
      ?? (await this.repo.getBySourceId(anchorId));
    if (!anchorEntry) return null;

    // 剩余 query（去除原始大小写的 ID + trim）走 RRF
    const remaining = queryString.replace(rawId, "").trim();
    const detailLevel = query.detailLevel ?? "summary";

    let rrfResult: RetrievalResult;
    if (remaining) {
      const remainingQuery = {
        ...query,
        query: remaining,
        // anchor 命中已顶格，剩余 RRF 结果数量保持原 limit-1（让 anchor + RRF 总和约等于 limit）
        limit: Math.max(query.limit - 1, 1),
      };
      // 审视 B3：按原 library 路由走（全库时含术语库混排，不能只走 conversation）
      rrfResult = query.library === "conversation"
        ? await this.searchConversation(remainingQuery)
        : await this.searchAllLibraries(remainingQuery);
    } else {
      rrfResult = { entries: [], total: 0, vecCoverage: this.buildVecCoverage(0, 0) };
    }

    // 组装 anchor entry 为 RetrievalResultEntry
    const anchorResultEntry = this.buildAnchorEntry(anchorEntry, detailLevel);

    return {
      entries: [anchorResultEntry, ...rrfResult.entries],
      total: rrfResult.total + 1,
      vecCoverage: rrfResult.vecCoverage,
    };
  }

  /** F20260812mrcq Part 3: 把 anchor 命中 entry 组装为 RetrievalResultEntry（source='anchor'） */
  private buildAnchorEntry(entry: MemoryEntry, detailLevel: DetailLevel): RetrievalResultEntry {
    const base = detailLevel === "full"
      ? entry
      : { ...entry, content: "" };
    const snippetText = detailLevel === "summary"
      ? entry.content.slice(0, SNIPPET_FALLBACK_LENGTH)
      : entry.content;
    return {
      ...base,
      score: 1.0,  // anchor 顶格，score=1.0 不参与 RRF 比较
      source: "anchor",
      snippet: snippetText,
      drillDown: detailLevel !== "full"
        ? { tool: "get_memory_detail", params: { id: entry.id } }
        : undefined,
    };
  }

  /** 对话库检索（原有逻辑） */
  private async searchConversation(query: SearchQuery): Promise<RetrievalResult> {
    return this.searchConversationInternal(query);
  }

  /**
   * F20260812mrcq Part 2: 为 top-K 命中扩展邻域上下文。
   * - chunk 命中：按 sourceId + chunk_index ±1 扩展
   * - message 命中：按 conversationId + createdAt 前后各一条扩展
   * - summary / fact / linked_resource：no-op（无邻域结构）
   * 已被 entries 命中的条目不重复扩展。
   * 不参与 RRF，独立放在 contextEntries。
   */
  private async expandContextForEntries(entries: RetrievalResultEntry[]): Promise<RetrievalResultEntry[]> {
    const existingIds = new Set(entries.map(e => e.id));
    const result: RetrievalResultEntry[] = [];
    const seen = new Set<string>();  // 跨命中去重（如同源多 chunk 命中扩展到同一邻域）

    for (const entry of entries) {
      let neighbors: MemoryEntry[];
      if (entry.contentType === "feature_chunk" || entry.contentType === "research_chunk") {
        const chunkIndex = Number(entry.metadata?.chunk_index);
        if (!Number.isFinite(chunkIndex)) continue;
        neighbors = await this.repo.findNeighborsByChunkIndex(
          entry.sourceTable, entry.sourceId, chunkIndex,
        );
      } else if (entry.contentType === "message" && entry.conversationId) {
        neighbors = await this.repo.findNeighborsByTime(
          entry.conversationId, entry.createdAt,
        );
      } else {
        continue;  // summary / fact / linked_resource no-op
      }

      for (const nb of neighbors) {
        if (existingIds.has(nb.id) || seen.has(nb.id)) continue;
        seen.add(nb.id);
        result.push({
          ...nb,
          content: "",  // 渐进式披露：snippet 模式下 content 置空
          score: 0,  // 不参与 RRF 比较
          source: "context-expand",
          drillDown: { tool: "get_memory_detail", params: { id: nb.id } },
          snippet: nb.content.slice(0, SNIPPET_FALLBACK_LENGTH),
        });
      }
    }
    return result;
  }

  /** 术语库检索 */
  private async searchTerminologyLibrary(query: SearchQuery): Promise<RetrievalResult> {
    if (!this.terminologyRepo) {
      return { entries: [], total: 0, vecCoverage: this.buildVecCoverage(0, 0) };
    }
    const results = await this.terminologyRepo.search(query.query, query.limit);
    const detailLevel = query.detailLevel ?? "summary";
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
        layer: "working" as const,
        contentType: "fact" as const,
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
    // F20260811mrpy Part 1：术语库不索引 vec，withVec 恒为 0
    return { entries, total: entries.length, vecCoverage: this.buildVecCoverage(entries.length, 0) };
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

    // F20260811mrpy Part 1：合并对话库 vecCoverage + 术语库（术语库不索引 vec）
    const convWithVec = convResult.vecCoverage.withVec;
    const mergedVecCoverage = this.buildVecCoverage(entries.length, convWithVec);

    return { entries, total: entries.length, vecCoverage: mergedVecCoverage };
  }

  /** 术语库搜索辅助方法（用于全库搜索混排） */
  private async searchTerminologyEntries(query: SearchQuery): Promise<(RetrievalResultEntry & { normalizedScore: number; library: string; libraryPriority: number })[]> {
    if (!this.terminologyRepo) return [];
    const results = await this.terminologyRepo.search(query.query, query.limit);
    const detailLevel = query.detailLevel ?? "summary";
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
        layer: "working" as const,
        contentType: "fact" as const,
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
    const detailLevel = query.detailLevel ?? "summary";
    const filters: SearchFilters = {
      layer: query.layer,
      granularity: query.granularity,
      conversationId: query.conversationId,
      createdAfter: query.createdAfter,
      contentType: query.contentType,
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
      // F20260803chunk M6: FTS 预聚合，每 source 最多保留 top-3 chunk 防 long doc 霸占 limit
      const aggregatedFts = this.preAggregateFtsBySource(ftsHits);
      snippetMap = new Map(aggregatedFts.map((h) => [h.entryId, h.snippet]));
      // PR审视 B10: vec 预聚合同样限制每 source top-3，防长文档 chunk 霸占 RRF
      const vecHits = this.preAggregateVecBySource(await this.searchVec(query.query, filters, query.limit));
      rrfHits = this.searchEngine.rrfFusion(
        aggregatedFts.map((h) => ({ entryId: h.entryId, ftsRank: h.ftsRank, entry: h.entry })),
        vecHits,
      );
    } else {
      const ftsHits = await this.repo.searchFTS(query.query, filters);
      const aggregatedFts = this.preAggregateFtsBySource(ftsHits);
      const vecHits = this.preAggregateVecBySource(await this.searchVec(query.query, filters, query.limit));
      rrfHits = this.searchEngine.rrfFusion(aggregatedFts, vecHits);
    }

    /** 2. 重排 + 返回（传递 snippet 信息用于降级） */
    return this.rerankAndReturn(rrfHits, query.limit, detailLevel, snippetMap, true, query.debug ?? false);
  }

  async searchSimilar(
    memoryEntryId: string,
    limit: number,
  ): Promise<RetrievalResult> {
    /** 1. 获取 embedding */
    const embedding = await this.repo.getEmbedding(memoryEntryId);
    if (!embedding) {
      return { entries: [], total: 0, vecCoverage: this.buildVecCoverage(0, 0) };
    }

    /** 2. vec 搜索（limit+1 补偿自身匹配过滤） */
    const vecHits = await this.repo.searchVec(embedding, limit + 1, {});
    const filtered = vecHits.filter((h) => h.entryId !== memoryEntryId);

    /** 3. 单源 RRF + 重排（searchSimilar 不去重：语义是"找相似条目"，同源多 entry 合法） */
    const rrfHits = this.searchEngine.buildSingleSourceRrfHits(filtered);
    return this.rerankAndReturn(rrfHits, limit, undefined, undefined, false);
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
      this.logger.warn(`Embedding search failed, falling back to FTS5 only: ${err}`);
      return [];
    }
  }

  /**
   * RRF 融合后的结果重排 + 批量递增计数 + 组装返回值。
   * F20260811mrpy：扩展含 vecCoverage/debug/drillDown，参数数与复杂度合理增加。
   */
  // eslint-disable-next-line max-params -- F20260811mrpy 三 Part 扩展必要
  private async rerankAndReturn(
    rrfHits: Map<string, RrfHit>,
    limit: number,
    detailLevel?: DetailLevel,
    snippetMap?: Map<string, string | undefined>,
    /** F20260803fbit: searchSimilar 路径不需要按 sourceId 去重（语义是"找相似条目"，同源多 entry 是合法结果） */
    dedup = true,
    /** F20260811mrpy Part 1：debug=true 时注入中间分值 */
    debug = false,
  ): Promise<RetrievalResult> {
    const hitIds = Array.from(rrfHits.keys());
    if (hitIds.length === 0) {
      return { entries: [], total: 0, vecCoverage: this.buildVecCoverage(0, 0) };
    }

    const weights = await this.repo.getWeights(hitIds);
    const weightMap = new Map(weights.map((w) => [w.memoryEntryId, w]));

    const scored = this.searchEngine.rerank(rrfHits, weightMap);
    /** F20260803chunk: 按 (sourceTable, sourceId) 去重 + 多 chunk 命中加分（dedupAndBoostBySource） */
    const deduped = dedup ? this.dedupAndBoostBySource(scored) : scored;
    deduped.sort((a, b) => b.finalScore - a.finalScore);
    const top = deduped.slice(0, limit);

    /** S15: 批量递增检索计数 */
    await this.repo.incrementRetrievalCounts(top.map((h) => h.entryId));

    /** F20260811mrpy Part 1：计算 vecCoverage（默认返回） */
    const topIds = top.map(h => h.entryId);
    const hasVecMap = await this.repo.hasEmbeddings(topIds);
    const withVecCount = Array.from(hasVecMap.values()).filter(Boolean).length;
    const vecCoverage: VecCoverage = this.buildVecCoverage(top.length, withVecCount);

    return {
      // eslint-disable-next-line complexity -- F20260811mrpy debug/drillDown 注入增加分支
      entries: top.map((h) => {
        // M12: multi_hit_count 仅 >1 时注入 metadata（searchSimilar 路径无此字段不变）
        const meta = h.multiHitCount && h.multiHitCount > 1
          ? { ...(h.entry.metadata ?? {}), multi_hit_count: h.multiHitCount }
          : h.entry.metadata;
        // snippet/summary 模式 content 置空（渐进式披露：snippet 定位 → get_memory_detail 深入）
        const base = detailLevel === "full"
          ? h.entry
          : { ...h.entry, content: "" };
        /** F20260811mrpy Part 2：detail_level != "full" 时填充 drillDown hint */
        const drillDown = detailLevel && detailLevel !== "full"
          ? { tool: "get_memory_detail", params: { id: h.entryId } }
          : undefined;
        /** F20260811mrpy Part 1：debug=true 时注入中间分值 */
        const debugInfo = debug ? {
          rrfScore: h.rrfScore,
          finalScore: h.finalScore,
          timeDecay: this.searchEngine.computeTimeDecayPublic(h.entry.createdAt),
          frequencyBoost: this.searchEngine.computeFrequencyBoostPublic(
            weightMap.get(h.entryId)?.retrievalCount ?? 0,
          ),
          multiHitCount: h.multiHitCount,
        } : undefined;
        return {
          ...base,
          metadata: meta,
          score: h.finalScore,
          source: h.source,
          userFlagged: weightMap.get(h.entryId)?.userFlagged ?? false,
          ...(debugInfo ? { debug: debugInfo } : {}),
          ...(drillDown ? { drillDown } : {}),
          ...this.buildSnippet(h.entry, detailLevel, snippetMap),
        };
      }),
      total: top.length,
      vecCoverage,
    };
  }

  /**
   * F20260803chunk: 按 (sourceTable, sourceId) 去重 + 多 chunk 命中加分。
   * 同源多 chunk 命中是正信号（文档多处匹配），取最高分 chunk 作代表，
   * 加 additive boost（0.01/hit，封顶 5 hits=0.05，决策 D5+S2）。
   * M15: 创建新对象而非原地修改 finalScore（避免 mutation 风险）。
   * S8: tie-breaker 按 chunk_index 保证确定性。
   */
  private dedupAndBoostBySource(scored: ScoredHit[]): ScoredHit[] {
    const MULTI_HIT_BOOST = 0.01;
    const MAX_MULTI_HIT_BOOST_COUNT = 5;

    const groups = new Map<string, ScoredHit[]>();
    for (const hit of scored) {
      const key = `${hit.entry.sourceTable}|${hit.entry.sourceId}`;
      const group = groups.get(key);
      if (group) group.push(hit);
      else groups.set(key, [hit]);
    }

    const result: ScoredHit[] = [];
    for (const group of groups.values()) {
      // PR审视 M5：优先选 chunk 作代表（如 group 含 chunk 命中）——用户搜正文时应返回匹配的
      // 正文片段而非 summary 概述。无 chunk 命中时 fallback 到全部 group（summary-only 场景）。
      const CHUNK_TYPES = new Set(["feature_chunk", "research_chunk"]);
      const chunkHits = group.filter(h => CHUNK_TYPES.has(h.entry.contentType));
      const candidates = chunkHits.length > 0 ? chunkHits : group;
      // S8：tie-breaker 按 chunk_index 保证确定性（finalScore 相同时）
      candidates.sort((a, b) =>
        b.finalScore !== a.finalScore
          ? b.finalScore - a.finalScore
          : Number(a.entry.metadata?.chunk_index ?? 0) - Number(b.entry.metadata?.chunk_index ?? 0),
      );
      const best = candidates[0];
      // PR审视 B8/M4：multi_hit_count 只统计 chunk 命中（M6：用显式集合而非 includes 防误匹配）
      const chunkHitCount = chunkHits.length;
      const extraHits = Math.min(Math.max(chunkHitCount - 1, 0), MAX_MULTI_HIT_BOOST_COUNT);
      // M15：创建新对象而非原地修改
      result.push({
        ...best,
        finalScore: best.finalScore + MULTI_HIT_BOOST * extraHits,
        multiHitCount: chunkHitCount,
      });
    }
    return result;
  }

  /**
   * F20260803chunk M6: FTS 预聚合，每 (sourceTable, sourceId, contentType) 最多保留 top-3。
   * 防 long doc（53K 字符 × 19 chunk）占满 DEFAULT_FTS_LIMIT 挤掉其他文档（决策 D8）。
   * ftsRank 越小越好（BM25 rank）。B6: key 含 contentType 防 summary 被 chunk 挤掉。
   */
  private preAggregateFtsBySource<T extends { entryId: string; ftsRank: number; entry: MemoryEntry }>(hits: T[]): T[] {
    const groups = new Map<string, T[]>();
    for (const hit of hits) {
      const key = `${hit.entry.sourceTable}|${hit.entry.sourceId}|${hit.entry.contentType}`;
      const group = groups.get(key);
      if (group) group.push(hit);
      else groups.set(key, [hit]);
    }
    const result: T[] = [];
    for (const group of groups.values()) {
      group.sort((a, b) => a.ftsRank - b.ftsRank);
      result.push(...group.slice(0, 3));
    }
    return result;
  }

  /** PR审视 B10: vec 预聚合，每 (source, contentType) 最多 top-3，防长文档 chunk 霸占 RRF。distance 越小越好。 */
  private preAggregateVecBySource(hits: VecHit[]): VecHit[] {
    const groups = new Map<string, VecHit[]>();
    for (const hit of hits) {
      const key = `${hit.entry.sourceTable}|${hit.entry.sourceId}|${hit.entry.contentType}`;
      const group = groups.get(key);
      if (group) group.push(hit);
      else groups.set(key, [hit]);
    }
    const result: VecHit[] = [];
    for (const group of groups.values()) {
      group.sort((a, b) => a.distance - b.distance);
      result.push(...group.slice(0, 3));
    }
    return result;
  }

  /**
   * F20260812mrcq Part 2（审视 m5）：统一构造 VecCoverage，自动填充 vecDisabled。
   * vecDisabled 让消费方区分"无结果"vs"vec 路径运行时禁用"。
   */
  private buildVecCoverage(total: number, withVec: number): VecCoverage {
    return {
      total,
      withVec,
      ratio: total > 0 ? withVec / total : 0,
      vecDisabled: !this.repo.isVecEnabled(),
    };
  }

  /**
   * 根据 detail_level 构建返回内容。
   * 返回 { content } 用于覆盖 entry.content（渐进式披露核心：非 full 时裁剪），
   * 返回 { snippet } 用于 HTTP 端点高亮渲染。
   */
  private buildSnippet(
    entry: MemoryEntry,
    detailLevel?: DetailLevel,
    snippetMap?: Map<string, string | undefined>,
  ): { content: string; snippet?: string } {
    if (!detailLevel || detailLevel === "full") {
      return { content: entry.content };
    }

    /** 获取 FTS highlight 片段（vec-only 结果为 undefined） */
    const ftsSnippet = snippetMap?.get(entry.id);

    /** 截取到 SNIPPET_FALLBACK_LENGTH：FTS highlight 可能很长，统一截断防止上下文膨胀 */
    const rawSnippet = ftsSnippet ?? entry.content;
    const snippet = rawSnippet.length > SNIPPET_FALLBACK_LENGTH
      ? rawSnippet.slice(0, SNIPPET_FALLBACK_LENGTH)
      : rawSnippet;

    if (detailLevel === "summary") {
      /** summary：取 snippet 的第一句（Unicode Sentence_Terminal 覆盖中英日韩泰阿拉伯等所有语言的句末标点） */
      const firstSentence = new RegExp('^[^\\n\\p{Sentence_Terminal}]*[\\p{Sentence_Terminal}\\n]?', 'u').exec(snippet)?.[0] ?? snippet;
      return { content: firstSentence, snippet: firstSentence };
    }

    return { content: snippet, snippet };
  }
}
