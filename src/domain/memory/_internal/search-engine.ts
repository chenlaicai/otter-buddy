/**
 * 混合检索引擎：RRF 融合 + 权重重排。
 *
 * 纯算法模块，无数据库依赖。
 * 权重计算公式（S3-A6）：
 *   final_score = rrf_score
 *     × time_decay_weight          // exp(-ln(2) * age_days / half_life_days)
 *     × frequency_boost            // log(1 + retrieval_count) * factor + 1
 *     × task_relevance_weight      // same_path ? samePathBoost : crossPathDecay
 *     × user_flag_multiplier       // user_flagged ? userFlagMultiplier : 1.0
 */

import type {
  FTSHit,
  MemoryEntry,
  MemoryWeight,
  RrfHit,
  RetrievalSource,
  ScoredHit,
  VecHit,
} from "../model";

export interface SearchEngineConfig {
  /** RRF 融合参数 k（S3-A5） */
  rrfK: number;
  /** 权重半衰期天数（S3-I2） */
  weightHalfLifeDays: number;
  /** 同路径 task_relevance 加成（S3-A6） */
  samePathBoost: number;
  /** 跨路径 task_relevance 衰减（S3-A6） */
  crossPathDecay: number;
  /** 用户标记加成（S3-A6） */
  userFlagMultiplier: number;
  /** frequency_boost 系数（S3-A6） */
  frequencyBoostFactor: number;
}

export class SearchEngine {
  constructor(private readonly config: SearchEngineConfig) {}

  /** RRF 融合（k 值从 config 读取，不由调用方传入） */
  rrfFusion(ftsHits: FTSHit[], vecHits: VecHit[]): Map<string, RrfHit> {
    const k = this.config.rrfK;
    const scores = new Map<string, {
      score: number;
      entry: MemoryEntry;
      source: RetrievalSource;
    }>();

    for (const [rank, hit] of ftsHits.entries()) {
      const existing = scores.get(hit.memoryEntryId);
      const rrfScore = 1 / (k + rank + 1);
      if (existing) {
        existing.score += rrfScore;
        existing.source = "both";
      } else {
        scores.set(hit.memoryEntryId, {
          score: rrfScore, entry: hit.entry, source: "fts",
        });
      }
    }

    for (const [rank, hit] of vecHits.entries()) {
      const existing = scores.get(hit.memoryEntryId);
      const rrfScore = 1 / (k + rank + 1);
      if (existing) {
        existing.score += rrfScore;
        existing.source = "both";
      } else {
        scores.set(hit.memoryEntryId, {
          score: rrfScore, entry: hit.entry, source: "vec",
        });
      }
    }

    const result = new Map<string, RrfHit>();
    for (const [id, val] of scores) {
      result.set(id, {
        memoryEntryId: id,
        rrfScore: val.score,
        entry: val.entry,
        source: val.source,
      });
    }
    return result;
  }

  /** 将单源 vec 命中转换为 RrfHit 格式（searchSimilar 使用，S9） */
  buildSingleSourceRrfHits(vecHits: VecHit[]): Map<string, RrfHit> {
    const result = new Map<string, RrfHit>();
    for (const [rank, hit] of vecHits.entries()) {
      result.set(hit.memoryEntryId, {
        memoryEntryId: hit.memoryEntryId,
        rrfScore: 1 / (this.config.rrfK + rank + 1),
        entry: hit.entry,
        source: "vec",
      });
    }
    return result;
  }

  /** 计算最终权重 */
  computeFinalScore(
    rrfScore: number,
    weight: MemoryWeight,
    entryCreatedAt: string,
    currentTreePath: string | null,
    entryTreePath: string | null,
  ): number {
    return rrfScore
      * this.computeTimeDecay(entryCreatedAt)
      * this.computeFrequencyBoost(weight.retrievalCount)
      * this.computeTaskRelevance(entryTreePath, currentTreePath)
      * (weight.userFlagged ? this.config.userFlagMultiplier : 1.0);
  }

  /** 重排 */
  rerank(
    hits: Map<string, RrfHit>,
    weights: Map<string, MemoryWeight>,
    currentTreePath: string | null,
  ): ScoredHit[] {
    const result: ScoredHit[] = [];
    for (const [id, hit] of hits) {
      const weight = weights.get(id) ?? {
        memoryEntryId: id,
        retrievalCount: 0,
        lastRetrievedAt: null,
        userFlagged: false,
      };
      const finalScore = this.computeFinalScore(
        hit.rrfScore, weight, hit.entry.createdAt,
        currentTreePath, hit.entry.treePath,
      );
      result.push({
        memoryEntryId: id,
        finalScore,
        entry: hit.entry,
        source: hit.source,
      });
    }
    return result;
  }

  /** time_decay: exp(-ln(2) * age_days / half_life_days) */
  private computeTimeDecay(createdAt: string): number {
    const ageMs = Date.now() - new Date(createdAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return Math.exp(-Math.LN2 * ageDays / this.config.weightHalfLifeDays);
  }

  /** frequency_boost: log(1 + retrieval_count) * factor + 1 */
  private computeFrequencyBoost(retrievalCount: number): number {
    return Math.log(1 + retrievalCount) * this.config.frequencyBoostFactor + 1;
  }

  /** task_relevance: 同路径加成，跨路径衰减，无路径不加成不衰减 */
  private computeTaskRelevance(
    entryTreePath: string | null,
    currentTreePath: string | null,
  ): number {
    if (!entryTreePath || !currentTreePath) return 1.0;
    if (
      entryTreePath.startsWith(currentTreePath) ||
      currentTreePath.startsWith(entryTreePath)
    ) {
      return this.config.samePathBoost;
    }
    return this.config.crossPathDecay;
  }
}
