/**
 * 业务逻辑适配器：实现 MemoryPort，编排 repository + embedding + search-engine。
 *
 * 设计要点：
 * - store: 同步写入 DB + FTS5 + weights（单事务），异步 fire-and-forget embedding（D27）
 * - search: FTS5 + vec0(降级) + RRF 融合 + 权重重排 + 批量递增计数（S15）
 * - searchSimilar: getEmbedding -> searchVec -> 单源 rerank
 * - 降级策略（D22）：embedding 失败时降级为纯 FTS5，不抛出异常
 */

import type { EmbeddingService } from "@infra/embedding/service";
import { logger } from "@infra/logger";
import type { MemoryPort } from "../port";
import type {
  MemoryEntry,
  MemoryEntryInput,
  MemoryLayer,
  MemoryWeight,
  RetrievalResult,
  RrfHit,
  SearchQuery,
  VecHit,
} from "../model";
import type { MemoryRepository } from "./repository";
import type { SearchEngine } from "./search-engine";

export class MemoryAdapter implements MemoryPort {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly embedding: EmbeddingService,
    private readonly searchEngine: SearchEngine,
  ) {}

  async store(entry: MemoryEntryInput): Promise<string> {
    const id = crypto.randomUUID();

    /** 同步: memory_entries + memory_fts + memory_weights（单事务） */
    this.repo.storeEntry(id, entry);

    /** 异步: embedding -> memory_vec（D27: 不阻塞返回） */
    this.embedding.embed(entry.content)
      .then(emb => {
        try {
          this.repo.storeEmbedding(id, emb);
        } catch (err) {
          logger.warn(`Failed to store embedding for ${id}: ${err}`);
        }
      })
      .catch(err => {
        /** D22 写入侧降级: 该条目仅可通过 FTS5 检索 */
        logger.warn(`Embedding generation failed for ${id}: ${err}`);
      });

    return id;
  }

  async getById(id: string): Promise<MemoryEntry | null> {
    return this.repo.getById(id);
  }

  async getBySource(sourceTable: string, sourceId: string): Promise<MemoryEntry | null> {
    return this.repo.getBySource(sourceTable, sourceId);
  }

  async search(query: SearchQuery): Promise<RetrievalResult> {
    const limit = query.limit ?? 20;

    /** 1. FTS5 搜索（始终可用） */
    const ftsHits = this.repo.searchFTS(query.query, {
      layer: query.layer,
      granularity: query.granularity,
      conversationId: query.conversationId,
      limit,
    });

    /** 2. vec0 搜索（可能降级，D22） */
    const vecHits = await this.searchVec(query, limit);

    /** 3. RRF 融合 + 权重重排 + 返回 */
    const rrfHits = this.searchEngine.rrfFusion(ftsHits, vecHits);
    return this.rerankAndReturn(rrfHits, query.treePath ?? null, limit);
  }

  async searchSimilar(id: string, limit: number): Promise<RetrievalResult> {
    const embedding = this.repo.getEmbedding(id);
    if (!embedding) {
      return { entries: [], scores: [], sources: [] };
    }

    // Request limit+1 to compensate for self-match being filtered out
    const vecHits = this.repo.searchVec(embedding, { limit: limit + 1 });
    const filtered = vecHits.filter(h => h.memoryEntryId !== id);

    /** searchSimilar 仅有 vec 单源，跳过 RRF 直接做 rerank（S9） */
    const rrfHits = this.searchEngine.buildSingleSourceRrfHits(filtered);
    return this.rerankAndReturn(rrfHits, null, limit);
  }

  async updateLayerByConversation(
    conversationId: string,
    fromLayer: MemoryLayer,
    toLayer: MemoryLayer,
  ): Promise<void> {
    this.repo.updateLayerByConversation(conversationId, fromLayer, toLayer);
  }

  async getWeight(memoryEntryId: string): Promise<MemoryWeight> {
    return this.repo.getWeight(memoryEntryId);
  }

  async incrementRetrievalCount(memoryEntryId: string): Promise<void> {
    this.repo.incrementRetrievalCount(memoryEntryId);
  }

  async flagMemory(memoryEntryId: string, flagged: boolean): Promise<void> {
    this.repo.flagMemory(memoryEntryId, flagged);
  }

  async storeEmbedding(memoryEntryId: string, embedding: Float32Array): Promise<void> {
    this.repo.storeEmbedding(memoryEntryId, embedding);
  }

  async getEmbedding(memoryEntryId: string): Promise<Float32Array | null> {
    return this.repo.getEmbedding(memoryEntryId);
  }

  /** vec0 搜索（含降级逻辑，D22） */
  private async searchVec(
    query: SearchQuery,
    limit: number,
  ): Promise<VecHit[]> {
    if (!this.repo.hasVecTable()) return [];
    try {
      const queryEmbedding = await this.embedding.embed(query.query);
      return this.repo.searchVec(queryEmbedding, {
        layer: query.layer,
        granularity: query.granularity,
        conversationId: query.conversationId,
        limit,
      });
    } catch (err) {
      logger.warn(`Embedding search failed, falling back to FTS5 only: ${err}`);
      return [];
    }
  }

  /** RRF 融合后的结果重排 + 批量递增计数 + 组装返回值 */
  private rerankAndReturn(
    rrfHits: Map<string, RrfHit>,
    treePath: string | null,
    limit: number,
  ): RetrievalResult {
    const hitIds = Array.from(rrfHits.keys());
    const weights = this.repo.getWeights(hitIds);
    const scored = this.searchEngine.rerank(rrfHits, weights, treePath);
    scored.sort((a, b) => b.finalScore - a.finalScore);
    const top = scored.slice(0, limit);

    /** S15: 批量递增检索计数（事务包裹保证原子性） */
    this.repo.incrementRetrievalCounts(top.map(h => h.memoryEntryId));

    return {
      entries: top.map(h => h.entry),
      scores: top.map(h => h.finalScore),
      sources: top.map(h => h.source),
    };
  }
}
