import type { MemoryEntry, MemoryWeight } from "@entities/memory/memory-entry";
import type { RetrievalSource, FTSHit, VecHit } from "./memory-types";

/** F20260902rcp1: document 层条目类型——半衰期分层与层配额共用此集合（导出供 search-memory debug 注入复用） */
export const DOCUMENT_CONTENT_TYPES = new Set(["feature", "research", "feature_chunk", "research_chunk"]);

export interface SearchEngineConfig {
  rrfK: number;
  /** Vec 权重（0-1），0=纯 FTS，1=纯 Vec，默认 0.4（偏信任 FTS） */
  alpha: number;
  /** Vec 相似度阈值，低于此值的结果被过滤，默认 0.3 */
  vecSimilarityThreshold: number;
  /** 两路命中（source=both）的加成系数，默认 1.2 */
  bothBoost: number;
  weightHalfLifeDays: number;
  /** F20260902rcp1: document 层（feature/research summary+chunk）专用半衰期，默认 90 天——
   *  7 天半衰期下一个月前的文档权重只剩 5%，「找历史特性」类查询永久出局（Phase 0 根因3） */
  weightHalfLifeDaysDocument: number;
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
  /** F20260803chunk: 同源多 chunk 命中数（dedupAndBoostBySource 设置，>1 时注入返回 metadata） */
  multiHitCount?: number;
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

  /** F20260902rcp1 审视修复：debug 注入需要按层取半衰期，暴露 config 读取（只读语义） */
  get configRef(): Readonly<SearchEngineConfig> {
    return this.config;
  }

  /**
   * RRF 融合：FTS + Vec 两路结果合并（三阶段策略）
   *
   * 阶段 1：Vec 质量门控 - 过滤掉 similarity < vecSimilarityThreshold 的结果
   * 阶段 2：加权 RRF - 用 alpha 控制 FTS 和 Vec 的权重
   * 阶段 3：一致性加权 - 两路命中的结果给予 bothBoost 加成
   */
  rrfFusion(ftsHits: FTSHit[], vecHits: VecHit[]): Map<string, RrfHit> {
    const k = this.config.rrfK;
    const ftsWeight = 1 - this.config.alpha;
    const vecWeight = this.config.alpha;

    // 阶段 1：Vec 质量门控
    const filteredVecHits = this.filterVecHitsByThreshold(vecHits);

    // 阶段 2：加权 RRF 融合
    const scores = this.mergeWeightedScores(ftsHits, filteredVecHits, k, ftsWeight, vecWeight);

    // 阶段 3：一致性加权
    return this.applyBothBoost(scores);
  }

  /** 阶段 1：过滤低相似度的 Vec 结果 */
  private filterVecHitsByThreshold(vecHits: VecHit[]): VecHit[] {
    const threshold = this.config.vecSimilarityThreshold;
    return vecHits.filter(hit => (1 - hit.distance) >= threshold);
  }

  /** 阶段 2：加权 RRF 融合 FTS 和 Vec 结果 */
  private mergeWeightedScores(
    ftsHits: FTSHit[],
    vecHits: VecHit[],
    k: number,
    ftsWeight: number,
    vecWeight: number,
  ): Map<string, { score: number; entry: MemoryEntry; source: RetrievalSource }> {
    const scores = new Map<string, { score: number; entry: MemoryEntry; source: RetrievalSource }>();

    for (const [rank, hit] of ftsHits.entries()) {
      this.addWeightedScore(scores, hit.entryId, hit.entry, ftsWeight * (1 / (k + rank + 1)), "fts");
    }

    for (const [rank, hit] of vecHits.entries()) {
      this.addWeightedScore(scores, hit.entryId, hit.entry, vecWeight * (1 / (k + rank + 1)), "vec");
    }

    return scores;
  }

  /** 添加加权分数到 scores Map */
  private addWeightedScore(
    scores: Map<string, { score: number; entry: MemoryEntry; source: RetrievalSource }>,
    entryId: string,
    entry: MemoryEntry,
    rrfScore: number,
    source: RetrievalSource,
  ): void {
    const existing = scores.get(entryId);
    if (existing) {
      existing.score += rrfScore;
      existing.source = "both";
    } else {
      scores.set(entryId, { score: rrfScore, entry, source });
    }
  }

  /** 阶段 3：对两路命中的结果应用 bothBoost 加成 */
  private applyBothBoost(
    scores: Map<string, { score: number; entry: MemoryEntry; source: RetrievalSource }>,
  ): Map<string, RrfHit> {
    const result = new Map<string, RrfHit>();
    for (const [id, val] of scores) {
      const finalRrfScore = val.source === "both"
        ? val.score * this.config.bothBoost
        : val.score;
      result.set(id, {
        entryId: id,
        rrfScore: finalRrfScore,
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

  /** 权重重排：rrfScore × timeDecay × frequencyBoost × userFlagMultiplier
   *  F20260902rcp1: document 层（feature/research summary+chunk）按 weightHalfLifeDaysDocument 衰减，
   *  其余层维持 weightHalfLifeDays。 */
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
      const halfLifeDays = DOCUMENT_CONTENT_TYPES.has(hit.entry.contentType)
        ? this.config.weightHalfLifeDaysDocument
        : this.config.weightHalfLifeDays;
      const finalScore =
        hit.rrfScore *
        this.computeTimeDecay(hit.entry.createdAt, halfLifeDays) *
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

  /** time_decay: exp(-ln(2) * age_days / half_life_days)
   *  F20260902rcp1: halfLifeDays 可选参数——document 层传 90 天半衰期，缺省走 weightHalfLifeDays（旧行为） */
  private computeTimeDecay(createdAt: string, halfLifeDays?: number): number {
    const hl = halfLifeDays ?? this.config.weightHalfLifeDays;
    /** SQLite datetime('now') returns UTC as "YYYY-MM-DD HH:MM:SS" (space-separated).
     * JS Date parses space-separated dates as local time; normalize to ISO 8601 UTC. */
    const utc = createdAt.includes("T")
      ? createdAt
      : createdAt.replace(" ", "T") + "Z";
    const ageMs = Date.now() - new Date(utc).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return Math.exp(-Math.LN2 * ageDays / hl);
  }

  /** frequency_boost: log(1 + retrieval_count) * factor + 1 */
  private computeFrequencyBoost(retrievalCount: number): number {
    return Math.log(1 + retrievalCount) * this.config.frequencyBoostFactor + 1;
  }

  /**
   * F20260811mrpy Part 1：public 暴露 time_decay 计算（debug 信息注入用）。
   * 与内部 computeTimeDecay 等价。
   */
  computeTimeDecayPublic(createdAt: string, halfLifeDays?: number): number {
    return this.computeTimeDecay(createdAt, halfLifeDays);
  }

  /**
   * F20260811mrpy Part 1：public 暴露 frequency_boost 计算（debug 信息注入用）。
   * 与内部 computeFrequencyBoost 等价。
   */
  computeFrequencyBoostPublic(retrievalCount: number): number {
    return this.computeFrequencyBoost(retrievalCount);
  }
}
