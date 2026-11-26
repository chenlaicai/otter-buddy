import type { MemoryEntry, MemoryWeight } from "@entities/memory/memory-entry";
import { parseBeliefMetadata } from "@entities/memory/belief";
import type { BeliefStatus } from "@entities/memory/belief";
import type { RetrievalSource, FTSHit, VecHit } from "./memory-types";

/** document 层条目类型——半衰期分层与层配额共用此集合（导出供 search-memory debug 注入复用） */
export const DOCUMENT_CONTENT_TYPES = new Set(["feature", "research", "feature_chunk", "research_chunk"]);

/** rerank 融合模式。multiply=五信号连乘（现状），additive=归一化加法融合。 */
export type RerankMode = "multiply" | "additive";

/** 加法融合系数与偏置（隐微权重和为 1，见 normalizeRerankWeights）。 */
export interface RerankWeights {
  wRrf: number;
  wTime: number;
  wFreq: number;
  bUserFlag: number;
  bConv: number;
  /** frequency 饱和截断的检索次数上限，归一化口径 CAP=log(1+freqCap) */
  freqCap: number;
}

/** 方案 1：RRF 候选池内 min-max 归一化。
 *  单候选池与全并列退化为常量 1.0（单调变换，排序与 raw RRF 一致）。 */
export function normalizeRrfPool(scores: number[]): number[] {
  if (scores.length === 0) return [];
  if (scores.length === 1) return [1.0];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max === min) return scores.map(() => 1.0);
  return scores.map(x => (x - min) / (max - min));
}

/** 方案 1：frequency 饱和截断归一化——min(log(1+n), CAP)/CAP，CAP=log(1+countCap)。 */
export function normalizeFrequency(retrievalCount: number, countCap = 10): number {
  const cap = Math.log(1 + countCap);
  return Math.min(Math.log(1 + retrievalCount), cap) / cap;
}

/** 方案 2：连续权重 w_rrf+w_time+w_freq 归一化为 1（比例归一，防坏配置静默采用）。
 *  和为 0（纯偏置配置）时不做除法，原样返回。 */
export function normalizeRerankWeights(weights: RerankWeights): RerankWeights {
  const sum = weights.wRrf + weights.wTime + weights.wFreq;
  if (sum <= 0) return weights;
  const factor = 1 / sum;
  return {
    ...weights,
    wRrf: weights.wRrf * factor,
    wTime: weights.wTime * factor,
    wFreq: weights.wFreq * factor,
  };
}

/** belief 状态相对权重（应用于 beliefBoost 之上）。
 *  verified=1.0（全加成）；recorded=0.6（可用但 [未核实] 不当权威）；
 *  disputed=0.3（打回重新入审，存疑）；superseded=0.1（已被取代，可检索但深埋）。 */
export function beliefStatusMultiplier(status: BeliefStatus): number {
  switch (status) {
    case "verified": return 1.0;
    case "recorded": return 0.6;
    case "disputed": return 0.3;
    case "superseded": return 0.1;
  }
}

export interface SearchEngineConfig {
  rrfK: number;
  /** Vec 权重（0-1），0=纯 FTS，1=纯 Vec，默认 0.4（偏信任 FTS） */
  alpha: number;
  /** Vec 相似度阈值，低于此值的结果被过滤，默认 0.1 */
  vecSimilarityThreshold: number;
  /** Vec 候选池深度（vec0 KNN k），默认 20。原池深跟随 query.limit（search-memory.ts）隐式耦合，
   *  与 FTS 池 50 不对称；评测 t0.1-k20-h14 验证池深 20 且扫描延迟不增（全表扫，k 不影响扫描量级）。 */
  vecCandidateLimit?: number;
  /** 两路命中（source=both）的加成系数，默认 1.2 */
  bothBoost: number;
  /** 本对话来源记忆条目的排序加成系数（>1），默认 1.5——
   *  搭档「本对话的历史消息权重应该更高」：长对话几十世同一主题，本对话来源
   *  的记忆与当前语境天然强相关。乘法加成（与 userFlagMultiplier 同型），
   *  作用于 rerank 阶段（RRF 之后），保留跨对话知识可见只是排序下沉。 */
  currentConversationBoost: number;
  weightHalfLifeDays: number;
  /** document 层（feature/research summary+chunk）专用半衰期，默认 90 天——
   * 7 天半衰期下一个月前的文档权重只剩 5%，「找历史特性」类查询永久出局（根因3） */
  weightHalfLifeDaysDocument: number;
  userFlagMultiplier: number;
  frequencyBoostFactor: number;
  /** rerank 融合模式；缺省 additive，显式 multiply 可回退旧连乘。 */
  rerankMode?: RerankMode;
  /** 加法融合系数（wRrf/wTime/wFreq 连续权重隐微和为 1，运行时在 rerankAdditive 内比例归一）。缺省在构造时回填。 */
  rerank?: RerankWeights;
  /** 被 supersedes 边指向的旧条目的降权因子（finalScore × 此值）。可选，构造时回填默认 0.3。 */
  supersededPenalty?: number;
  /** 主动记忆层（belief）排序加成系数，默认 2.0——检索最高优先级（v4）。缺省在构造时回填。 */
  beliefBoost?: number;
}

/** 加法融合系数缺省（设计回填，段 1 不切默认；标定后段 3 再写回）。 */
export const DEFAULT_RERANK_WEIGHTS: RerankWeights = {
  wRrf: 0.6,
  wTime: 0.3,
  wFreq: 0.1,
  bUserFlag: 0.05,
  bConv: 0.05,
  freqCap: 10,
};

/** Vec 候选池深度缺省：配置为可选字段，构造回填与跨 usecase 接线共用此常量防漂移。 */
export const DEFAULT_VEC_CANDIDATE_LIMIT = 20;

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
  /** 同源多 chunk 命中数（dedupAndBoostBySource 设置，>1 时注入返回 metadata） */
  multiHitCount?: number;
  /** 段 2：additive 分解分量（仅 rerankAdditive 填充；multiply 路径 undefined）。
   *  finalScore（去重前）= contribRrf + contribTime + contribFreq + biasFlag + biasConv。 */
  contribRrf?: number;
  contribTime?: number;
  contribFreq?: number;
  biasFlag?: number;
  biasConv?: number;
  /** 被哪个条目取代（supersedes 边的 from 端=取代者/新条目），有则说明此条已过期，检索端标注并降权。 */
  supersededBy?: string;
  /** belief 生命周期状态（供结果标注 [未核实]/[已核实]/[存疑]）。 */
  beliefStatus?: BeliefStatus;
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
 * × conversation_boost // 本对话来源条目 × currentConversationBoost（rerank 传 currentConversationId 时）
 */
export class SearchEngine {
  private readonly config: SearchEngineConfig;

  constructor(config: SearchEngineConfig = {} as SearchEngineConfig) {
    // 引擎与应用配置缺省同为 additive，避免直接构造时落入另一套排序。
    // 连续权重的比例归一（normalizeRerankWeights）在 rerankAdditive 调用时执行，不在构造时。
    this.config = {
      ...config,
      rerankMode: config.rerankMode ?? "additive",
      rerank: config.rerank ?? DEFAULT_RERANK_WEIGHTS,
      supersededPenalty: config.supersededPenalty ?? 0.3,
      beliefBoost: config.beliefBoost ?? 2.0,
      vecCandidateLimit: config.vecCandidateLimit ?? DEFAULT_VEC_CANDIDATE_LIMIT,
    };
  }

  /** 审视修复：debug 注入需要按层取半衰期，暴露 config 读取（只读语义） */
  get configRef(): Readonly<SearchEngineConfig> {
    return this.config;
  }

  /**
   * RRF 融合：FTS + Vec 两路结果合并（三阶段策略）
   *
   * Vec 质量门控 - 过滤掉 similarity < vecSimilarityThreshold 的结果
   * 加权 RRF - 用 alpha 控制 FTS 和 Vec 的权重
   * 一致性加权 - 两路命中的结果给予 bothBoost 加成
   */
  rrfFusion(ftsHits: FTSHit[], vecHits: VecHit[]): Map<string, RrfHit> {
    const k = this.config.rrfK;
    const ftsWeight = 1 - this.config.alpha;
    const vecWeight = this.config.alpha;

    // Vec 质量门控
    const filteredVecHits = this.filterVecHitsByThreshold(vecHits);

    // 加权 RRF 融合
    const scores = this.mergeWeightedScores(ftsHits, filteredVecHits, k, ftsWeight, vecWeight);

    // 一致性加权
    return this.applyBothBoost(scores);
  }

  /** 过滤低相似度的 Vec 结果 */
  private filterVecHitsByThreshold(vecHits: VecHit[]): VecHit[] {
    const threshold = this.config.vecSimilarityThreshold;
    return vecHits.filter(hit => (1 - hit.distance) >= threshold);
  }

  /** 加权 RRF 融合 FTS 和 Vec 结果 */
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

  /** 对两路命中的结果应用 bothBoost 加成 */
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

  /** 被 supersedes 边指向的旧条目降权系数——命中返回 supersededPenalty，否则 1。 */
  private supersededMultiplier(
    entryId: string,
    supersededById?: ReadonlyMap<string, string>,
  ): number {
    return supersededById?.has(entryId) ? this.config.supersededPenalty ?? 0.3 : 1.0;
  }

  /** 取取代此条目的新条目 ID（无则 undefined）。 */
  private supersededLabel(
    entryId: string,
    supersededById?: ReadonlyMap<string, string>,
  ): string | undefined {
    return supersededById?.get(entryId);
  }

  /** belief 条目排序因子与状态（非 belief 返回因子 1、无状态）。 */
  private beliefFactor(entry: MemoryEntry): { factor: number; status: BeliefStatus | undefined } {
    if (entry.contentType !== "belief") return { factor: 1.0, status: undefined };
    const belief = parseBeliefMetadata(entry);
    if (!belief) return { factor: 1.0, status: undefined };
    return {
      factor: (this.config.beliefBoost ?? 2.0) * beliefStatusMultiplier(belief.status),
      status: belief.status,
    };
  }

  /** 权重重排：rrfScore × timeDecay × frequencyBoost × userFlagMultiplier × conversationBoost
   * document 层（feature/research summary+chunk）按 weightHalfLifeDaysDocument 衰减，
   *  其余层维持 weightHalfLifeDays。
   * supersededById 里的条目再乘 supersededPenalty，并透出 supersededBy。 */
  rerank(
    hits: Map<string, RrfHit>,
    weights: Map<string, MemoryWeight>,
    /** 当前对话 ID——命中条目 conversationId 匹配时乘 currentConversationBoost */
    currentConversationId?: string,
    /** 被 supersede 的旧条目 → 取代它的条目 */
    supersededById?: ReadonlyMap<string, string>,
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
      const { factor: beliefFactor, status: beliefStatus } = this.beliefFactor(hit.entry);
      const finalScore =
        hit.rrfScore *
        this.computeTimeDecay(hit.entry.createdAt, halfLifeDays) *
        this.computeFrequencyBoost(weight.retrievalCount) *
        (weight.userFlagged ? this.config.userFlagMultiplier : 1.0) *
        (currentConversationId && hit.entry.conversationId === currentConversationId
          ? this.config.currentConversationBoost
          : 1.0) *
        this.supersededMultiplier(id, supersededById) *
        beliefFactor;
      const supersededBy = this.supersededLabel(id, supersededById);
      result.push({
        entryId: id,
        finalScore,
        rrfScore: hit.rrfScore,
        entry: hit.entry,
        source: hit.source,
        ...(supersededBy ? { supersededBy } : {}),
        ...(beliefStatus ? { beliefStatus } : {}),
      });
    }
    return result;
  }

  /** 段 1：归一化加法融合路径（与 rerank() 并存，rerankMode=additive 时调用）。
   *  score = w_rrf·norm(rrf) + w_time·timeDecay + w_freq·norm(freq) + b_flag·[flagged] + b_conv·[同对话]
   *  连续权重隐微和为 1（normalizeRerankWeights 比例归一）；rrf 池内 min-max、freq 饱和截断。 */
  rerankAdditive(
    hits: Map<string, RrfHit>,
    weights: Map<string, MemoryWeight>,
    currentConversationId?: string,
    supersededById?: ReadonlyMap<string, string>,
  ): ScoredHit[] {
    const w = normalizeRerankWeights(this.config.rerank ?? DEFAULT_RERANK_WEIGHTS);
    const hitList = Array.from(hits.values());
    const rrfNorm = normalizeRrfPool(hitList.map(hit => hit.rrfScore));
    const result: ScoredHit[] = [];
    hitList.forEach((hit, i) => {
      const weight = weights.get(hit.entryId) ?? {
        memoryEntryId: hit.entryId,
        retrievalCount: 0,
        lastRetrievedAt: null,
        userFlagged: false,
      };
      const halfLifeDays = DOCUMENT_CONTENT_TYPES.has(hit.entry.contentType)
        ? this.config.weightHalfLifeDaysDocument
        : this.config.weightHalfLifeDays;
      const timeDecay = this.computeTimeDecay(hit.entry.createdAt, halfLifeDays);
      const freqNorm = normalizeFrequency(weight.retrievalCount, w.freqCap);
      const isFlagged = weight.userFlagged;
      const isCurrentConversation = Boolean(
        currentConversationId && hit.entry.conversationId === currentConversationId,
      );
      const supersededBy = this.supersededLabel(hit.entryId, supersededById);
      const { factor: beliefFactor, status: beliefStatus } = this.beliefFactor(hit.entry);
      const finalScore =
        (w.wRrf * rrfNorm[i]
          + w.wTime * timeDecay
          + w.wFreq * freqNorm
          + (isFlagged ? w.bUserFlag : 0)
          + (isCurrentConversation ? w.bConv : 0)) *
        this.supersededMultiplier(hit.entryId, supersededById) *
        beliefFactor;
      // 段 2：透出逐信号贡献分量，供 debug 通道采集（逐信号对比表不靠外部重算）
      const contribRrf = w.wRrf * rrfNorm[i];
      const contribTime = w.wTime * timeDecay;
      const contribFreq = w.wFreq * freqNorm;
      const biasFlag = isFlagged ? w.bUserFlag : 0;
      const biasConv = isCurrentConversation ? w.bConv : 0;
      result.push({
        entryId: hit.entryId,
        finalScore,
        rrfScore: hit.rrfScore,
        entry: hit.entry,
        source: hit.source,
        contribRrf,
        contribTime,
        contribFreq,
        biasFlag,
        biasConv,
        ...(supersededBy ? { supersededBy } : {}),
        ...(beliefStatus ? { beliefStatus } : {}),
      });
    });
    return result;
  }

  /** time_decay: exp(-ln(2) * age_days / half_life_days)
   * halfLifeDays 可选参数——document 层传 90 天半衰期，缺省走 weightHalfLifeDays（旧行为） */
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
   * public 暴露 time_decay 计算（debug 信息注入用）。
   * 与内部 computeTimeDecay 等价。
   */
  computeTimeDecayPublic(createdAt: string, halfLifeDays?: number): number {
    return this.computeTimeDecay(createdAt, halfLifeDays);
  }

  /**
   * public 暴露 frequency_boost 计算（debug 信息注入用）。
   * 与内部 computeFrequencyBoost 等价。
   */
  computeFrequencyBoostPublic(retrievalCount: number): number {
    return this.computeFrequencyBoost(retrievalCount);
  }
}
