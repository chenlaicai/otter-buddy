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
  SearchFilters,
  RetrievalSource,
  VecHit,
} from "./memory-types";
import type { MemoryReader } from "./memory-reader";
import type { MemoryWriter } from "./memory-writer";
import type { TerminologyRepository } from "./terminology-repository";
import type { EmbeddingGateway } from "./embedding-gateway";
import type { SearchEngine, RrfHit, ScoredHit } from "./search-engine";
import type { Logger } from "@usecases/ports/logger";

/** snippet 降级截取长度（FTS5 highlight 不可用时） */
const SNIPPET_FALLBACK_LENGTH = 200;

/**
 * F20260812mrcq Part 3：F/R 文档 ID anchor 正则。
 * 子串提取（非全匹配）——支持 "F20260812mrcq 召回优化" 这种 "ID + 限定词" 模式。
 * 用 (?<![\w])/(?![\w]) 替代 \b 显式表达意图：ID 前后不能紧接 ASCII 单词字符。
 * 4-6 位后缀兼容历史（推荐 4 位）。
 * 修法：m3（#245 follow-up），用显式否定回顾/前瞻替代 \b 防未来 JS 引擎 Unicode \b 变更。
 */
const ANCHOR_PATTERN = /(?<![\w])([FR])\d{8}[a-z0-9]{4,6}(?![\w])/i;

/**
 * #542 修复：summary 模式首句提取正则（数字感知）。
 * 从 entry.content 原文开头提取首句：
 * - 主体 `[^\n]*?` 非贪婪同行拉长，直到「真正的句末」或行尾；
 * - 句末标点集 `[.。！？!?]` 含 ASCII `.`（英文句子）；数字感知终止（`(?!\d|[A-Za-z])`）：
 *   标点后紧跟数字/字母则非句末（`2.2 方案`、`v1.2`），避免编号标题被截断为 `2.`（issue 实证样本）；
 * - 换行无条件终止（markdown 行边界）；
 * - `$` 兜底：无终止符时取整行/整段。
 */
const FIRST_SENTENCE_PATTERN = /[^\n]*?(?:[.。！？!?](?!\d|[A-Za-z])|\n|$)/u;

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
  // eslint-disable-next-line max-params -- E 三分：拆为 Reader + Writer 双参数
  constructor(
    private readonly reader: MemoryReader,
    private readonly writer: MemoryWriter,
    private readonly embeddingGateway: EmbeddingGateway,
    private readonly searchEngine: SearchEngine,
    private readonly logger: Logger,
    private readonly terminologyRepo?: TerminologyRepository,
  ) {}

  // eslint-disable-next-line complexity -- F20260812mrcq 加 anchor 短路 + expandContext 分支后超 12
  async search(query: SearchQuery): Promise<RetrievalResult> {
    /**
     * F20260812mrcq Part 3: anchor 短路（仅 conversation / 全库，terminology 库跳过）。
     * 命中 F/R ID 时短路注入顶格，剩余 query 走 RRF。
     * 审视三轮 M3：用白名单式守卫——无效 library 值（如 "foo"）不走 anchor，让后续路由抛 DomainError。
     */
    if (!query.library || query.library === "conversation") {
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
      (await this.reader.getBySourceId(anchorId, preferredContentType as MemoryContentType))
      ?? (await this.reader.getBySourceId(anchorId));
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

    // m1（#245 follow-up）：anchor 命中不经过 dedupAndBoostBySource，
    // RRF 结果中同 sourceId 的 chunk 应过滤，避免 anchor summary + 同源 chunk 并列。
    const filteredEntries = rrfResult.entries.filter(
      e => e.sourceId !== anchorEntry.sourceId,
    );

    return {
      entries: [anchorResultEntry, ...filteredEntries],
      total: rrfResult.total + 1,
      vecCoverage: rrfResult.vecCoverage,
    };
  }

  /** F20260812mrcq Part 3: 把 anchor 命中 entry 组装为 RetrievalResultEntry（source='anchor'） */
  private buildAnchorEntry(entry: MemoryEntry, detailLevel: DetailLevel): RetrievalResultEntry {
    /** #542：非 full 时 content 用原文首句（summary 契约），不再置空 */
    const base = detailLevel === "full"
      ? { ...entry }
      : { ...entry, content: this.extractSummaryContent(entry.content) };
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
        neighbors = await this.reader.findNeighborsByChunkIndex(
          entry.sourceTable, entry.sourceId, chunkIndex,
        );
      } else if (entry.contentType === "message" && entry.conversationId) {
        neighbors = await this.reader.findNeighborsByTime(
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
          content: this.extractSummaryContent(nb.content),  // #542：summary 契约首句，不再置空
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
    // F20260811mrpy Part 1：术语库不索引 vec。
    // F20260821evaf 三轮审视：total 报 0（而非 entries.length）——术语条目恒无 vec，
    // 报实际数量会把 ratio 算成 0.0，误导消费方"全部暗化"。total=0 约定 = 本路由不参与 vec 统计。
    return { entries, total: entries.length, vecCoverage: this.buildVecCoverage(0, 0) };
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

    // F20260811mrpy Part 1：vecCoverage 只统计 vec 索引库（对话库）。
    // F20260821evaf 三轮审视修正：原用混排后 entries.length（含术语条目）作分母、
    // 对话库混排前 withVec 作分子，口径错位会把 ratio 系统性稀释甚至算成 0.0。
    // 直接透传对话库自身口径（分子分母同源），术语库不参与统计。
    return { entries, total: entries.length, vecCoverage: convResult.vecCoverage };
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
      const ftsHits = await this.reader.searchFTSWithHighlight(query.query, filters);
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
      const ftsHits = await this.reader.searchFTS(query.query, filters);
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
    const embedding = await this.reader.getEmbedding(memoryEntryId);
    if (!embedding) {
      return { entries: [], total: 0, vecCoverage: this.buildVecCoverage(0, 0) };
    }

    /** 2. vec 搜索（limit+1 补偿自身匹配过滤） */
    const vecHits = await this.reader.searchVec(embedding, limit + 1, {});
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
    if (!this.reader.hasVecTable()) return [];
    try {
      const queryEmbedding = await this.embeddingGateway.embed(query);
      return this.reader.searchVec(queryEmbedding, limit, filters);
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

    const weights = await this.reader.getWeights(hitIds);
    const weightMap = new Map(weights.map((w) => [w.memoryEntryId, w]));

    const scored = this.searchEngine.rerank(rrfHits, weightMap);
    /** F20260803chunk: 按 (sourceTable, sourceId) 去重 + 多 chunk 命中加分（dedupAndBoostBySource） */
    const deduped = dedup ? this.dedupAndBoostBySource(scored) : scored;
    deduped.sort((a, b) => b.finalScore - a.finalScore);
    /** F20260902rcp1: 层配额——doc summary 在 top-N 保底（去重豁免版，Phase 0 根因2） */
    const top = this.applyLayerQuota(deduped, limit).slice(0, limit);

    /** S15: 批量递增检索计数 */
    await this.writer.incrementRetrievalCounts(top.map((h) => h.entryId));

    /** F20260811mrpy Part 1：计算 vecCoverage（默认返回） */
    const topIds = top.map(h => h.entryId);
    const hasVecMap = await this.reader.hasEmbeddings(topIds);
    const withVecCount = Array.from(hasVecMap.values()).filter(Boolean).length;
    const vecCoverage: VecCoverage = this.buildVecCoverage(top.length, withVecCount);

    return {
      // eslint-disable-next-line complexity -- F20260811mrpy debug/drillDown 注入增加分支
      entries: top.map((h) => {
        // M12: multi_hit_count 仅 >1 时注入 metadata（searchSimilar 路径无此字段不变）
        const meta = h.multiHitCount && h.multiHitCount > 1
          ? { ...(h.entry.metadata ?? {}), multi_hit_count: h.multiHitCount }
          : h.entry.metadata;
        // #542：非 full 模式 content 由 buildSnippet 投影（summary=原文首句 / snippet=匹配窗口），
        // 不再置空——空 content 会摧毁 summary 模式的信息价值（渐进式披露的裁剪在 buildSnippet）
        const base = detailLevel === "full" ? h.entry : { ...h.entry };
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
  /**
   * F20260902rcp1: 层配额——doc summary（feature/research doc-level）在 top-N 保底。
   * 触发：top-N 中 doc summary 数量 < 配额 且命中集中存在该层条目（去重豁免：doc summary
   * 即使同源 chunk 已在结果中也插入——概览与正文并列是预期行为，配额条目不参与
   * dedupAndBoostBySource 的 chunk-priority 代表选择）。
   * 替换：从尾部向前替换非 doc-summary 条目；limit<6 时配额降 1 席（防小 limit 挢占）。
   */
  private applyLayerQuota(sorted: ScoredHit[], limit: number): ScoredHit[] {
    const DOC_SUMMARY_TYPES = new Set(["feature", "research"]);
    const quota = limit < 6 ? 1 : 2;
    if (sorted.length <= limit) return sorted;

    const isDocSummary = (h: ScoredHit) => DOC_SUMMARY_TYPES.has(h.entry.contentType);
    const inTop = sorted.slice(0, limit);
    const docCount = inTop.filter(isDocSummary).length;
    if (docCount >= quota) return sorted;

    // 从剩余命中中取 doc summary 候选（去重豁免：不同 source 或同 source 皆可）
    const candidates = sorted.slice(limit).filter(isDocSummary);
    if (candidates.length === 0) return sorted;

    const result = [...inTop];
    let need = quota - docCount;
    let replaceFrom = result.length - 1;
    while (need > 0 && candidates.length > 0 && replaceFrom >= 0) {
      const cand = candidates.shift()!;
      // 从尾部找非 doc-summary 条目替换
      while (replaceFrom >= 0 && isDocSummary(result[replaceFrom])) replaceFrom--;
      if (replaceFrom < 0) break;
      result[replaceFrom] = cand;
      replaceFrom--;
      need--;
    }
    return result;
  }

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
      vecDisabled: !this.reader.isVecEnabled(),
    };
  }

  /**
   * #542：summary 投影 content——原文首句（数字感知正则）。
   * 前导空白剥离（条目以空行/缩进开头时取首个实际内容行），行尾换行清理，
   * 超长截断到 SNIPPET_FALLBACK_LENGTH。由 buildSnippet / buildAnchorEntry /
   * expandContextForEntries 共用，保证三处投影点 summary 契约一致。
   */
  private extractSummaryContent(content: string): string {
    const firstSentence = FIRST_SENTENCE_PATTERN
      .exec(content.replace(/^\s+/, ""))?.[0]?.trimEnd() ?? content;
    return firstSentence.length > SNIPPET_FALLBACK_LENGTH
      ? firstSentence.slice(0, SNIPPET_FALLBACK_LENGTH)
      : firstSentence;
  }

  /**
   * 根据 detail_level 构建返回内容。
   * 返回 { content } 用于覆盖 entry.content（渐进式披露核心：非 full 时裁剪），
   * 返回 { snippet } 用于 HTTP 端点高亮渲染。
   *
   * #542 修复：content 与 snippet 语义分离——
   * - summary：content = 从 entry.content 原文开头提取的首句（与匹配位置无关，恒有意义）；
   *   snippet = FTS 匹配窗口（匹配上下文）。
   *   此前首句从 FTS 窗口提取：窗口起点在匹配词前 100 字符处，深匹配时带 `...` 前缀或
   *   恰以换行开头，首句正则匹配出 `.` / `\n`（40% 空投影的根因）。
   * - snippet：content = snippet = FTS 匹配窗口（不变）。
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
      /**
       * summary：content = 原文首句（#542：提取源从 FTS 窗口改为 entry.content，
       * 与匹配位置解耦——深匹配条目不再投影为空）。
       * 首句正则数字感知：句末标点后紧跟数字/拉丁字母时不是句末（`2.2 方案`、
       * `v1.2`、`e.g.`），编号标题行（`2.2 方案\n`）整行成首句而非截断为 `2.`。
       * 换行无条件终止（markdown 行边界语义）。
       */
      return { content: this.extractSummaryContent(entry.content), snippet };
    }

    return { content: snippet, snippet };
  }
}
