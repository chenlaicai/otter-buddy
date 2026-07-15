import type { MemoryEntry, MemoryWeight } from "@entities/memory/memory-entry";
import type { RetrievalSource, FTSHit, VecHit } from "./memory-repository";

export interface SearchEngineConfig {
  rrfK: number;
  weightHalfLifeDays: number;
  userFlagMultiplier: number;
  frequencyBoostFactor: number;
}

export interface RrfHit {
  entryId: string;
  rrfScore: number;
  source: RetrievalSource;
  entry: MemoryEntry;
}

export interface ScoredHit {
  entryId: string;
  finalScore: number;
  rrfScore: number;
  source: RetrievalSource;
  entry: MemoryEntry;
}

/**
 * 混合检索引擎：RRF 融合 + 权重重排。
 *
 * 纯算法模块，无数据库依赖。
 * 权重计算公式：
 *   final_score = rrf_score
 *     × time_decay          // exp(-ln(2) * age_days / half_life_days)
 *     × frequency_boost     // log(1 + retrieval_count) * factor + 1
 *     × user_flag_multiplier // user_flagged ? userFlagMultiplier : 1.0
 */
export class SearchEngine {
  constructor(private readonly config: SearchEngineConfig) {}

  /** RRF 融合：FTS + Vec 两路结果合并 */
  rrfFusion(ftsHits: FTSHit[], vecHits: VecHit[]): Map<string, RrfHit> {
    const k = this.config.rrfK;
    const scores = new Map<
      string,
      { score: number; entry: MemoryEntry; source: RetrievalSource }
    >();

    for (const [rank, hit] of ftsHits.entries()) {
      const rrfScore = 1 / (k + rank + 1);
      const existing = scores.get(hit.entryId);
      if (existing) {
        existing.score += rrfScore;
        existing.source = "both";
      } else {
        scores.set(hit.entryId, {
          score: rrfScore,
          entry: hit.entry,
          source: "fts",
        });
      }
    }

    for (const [rank, hit] of vecHits.entries()) {
      const rrfScore = 1 / (k + rank + 1);
      const existing = scores.get(hit.entryId);
      if (existing) {
        existing.score += rrfScore;
        existing.source = "both";
      } else {
        scores.set(hit.entryId, {
          score: rrfScore,
          entry: hit.entry,
          source: "vec",
        });
      }
    }

    const result = new Map<string, RrfHit>();
    for (const [id, val] of scores) {
      result.set(id, {
        entryId: id,
        rrfScore: val.score,
        entry: val.entry,
        source: val.source,
      });
    }
    return result;
  }

  /** 单源 RRF（用于 searchSimilar） */
  buildSingleSourceRrfHits(hits: VecHit[]): Map<string, RrfHit> {
    const result = new Map<string, RrfHit>();
    for (const [rank, hit] of hits.entries()) {
      result.set(hit.entryId, {
        entryId: hit.entryId,
        rrfScore: 1 / (this.config.rrfK + rank + 1),
        entry: hit.entry,
        source: "vec",
      });
    }
    return result;
  }

  /** 权重重排：rrfScore × timeDecay × frequencyBoost × userFlagMultiplier */
  rerank(
    hits: Map<string, RrfHit>,
    weights: Map<string, MemoryWeight>,
  ): ScoredHit[] {
    const result: ScoredHit[] = [];
    for (const [id, hit] of hits) {
      const weight = weights.get(id) ?? {
        memoryEntryId: id,
        retrievalCount: 0,
        lastRetrievedAt: null,
        userFlagged: false,
      };
      const finalScore =
        hit.rrfScore *
        this.computeTimeDecay(hit.entry.createdAt) *
        this.computeFrequencyBoost(weight.retrievalCount) *
        (weight.userFlagged ? this.config.userFlagMultiplier : 1.0);
      result.push({
        entryId: id,
        finalScore,
        rrfScore: hit.rrfScore,
        entry: hit.entry,
        source: hit.source,
      });
    }
    return result;
  }

  /** time_decay: exp(-ln(2) * age_days / half_life_days) */
  private computeTimeDecay(createdAt: string): number {
    /** SQLite datetime('now') returns UTC as "YYYY-MM-DD HH:MM:SS" (space-separated).
     * JS Date parses space-separated dates as local time; normalize to ISO 8601 UTC. */
    const utc = createdAt.includes("T")
      ? createdAt
      : createdAt.replace(" ", "T") + "Z";
    const ageMs = Date.now() - new Date(utc).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return Math.exp(-Math.LN2 * ageDays / this.config.weightHalfLifeDays);
  }

  /** frequency_boost: log(1 + retrieval_count) * factor + 1 */
  private computeFrequencyBoost(retrievalCount: number): number {
    return Math.log(1 + retrievalCount) * this.config.frequencyBoostFactor + 1;
  }
}
