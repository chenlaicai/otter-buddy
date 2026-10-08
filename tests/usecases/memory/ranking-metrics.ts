/**
 * F20261008mrrk Phase 0：排序质量指标纯函数（nDCG@K / MRR）。
 *
 * 评测域代码（测试层），不进 dist——评测是外挂观测，零生产行为变更。
 *
 * 相关性分级约定（golden 标注用，支持 nDCG 分级增益）：
 *   3 = 核心答案条目（查询要找的就是它）
 *   2 = 强相关（能直接支撑回答）
 *   1 = 弱相关（背景/补充信息）
 *   0 = 不相关（未标注默认 0）
 *
 * 增益函数用线性 rel（2^rel - 1 的指数增益在 3 级标注下方差过大，
 * 单条核心条目miss与多条弱相关命中的权衡会失衡——设计取舍见特性文档）。
 */

/** 单条 golden 查询的标注：entryId → 相关性分级（0-3） */
export type RelevanceMap = Map<string, number>;

/** DCG@K：位置折扣增益累积。对数折扣 log2(rank+1)，rank 从 1 起。 */
export function dcgAtK(rankedGrades: number[], k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(rankedGrades.length, k); i++) {
    dcg += rankedGrades[i] / Math.log2(i + 2);
  }
  return dcg;
}

/**
 * nDCG@K：DCG / IDCG。
 * - rankedIds：检索结果 entryId 有序列表
 * - relevance：该查询的标注（未标注 id 视为 0）
 * - IDCG = 标注增益降序取前 K 的 DCG（理想排序）
 * - 无任何正增益标注时返回 0（无相关条目的查询不参与评价，记 0 分；
 *   golden 集构造时应避免此类查询——runner 有结构断言拦截）
 */
export function ndcgAtK(rankedIds: string[], relevance: RelevanceMap, k: number): number {
  const gains = rankedIds.map((id) => relevance.get(id) ?? 0);
  const dcg = dcgAtK(gains, k);
  if (dcg === 0) return 0;
  const ideal = Array.from(relevance.values())
    .filter((g) => g > 0)
    .sort((a, b) => b - a);
  const idcg = dcgAtK(ideal, k);
  if (idcg === 0) return 0;
  return dcg / idcg;
}

/** RR：首个正增益条目位置的倒数，无命中为 0 */
export function reciprocalRank(rankedIds: string[], relevance: RelevanceMap): number {
  for (let i = 0; i < rankedIds.length; i++) {
    if ((relevance.get(rankedIds[i]) ?? 0) > 0) return 1 / (i + 1);
  }
  return 0;
}

/** MRR：多条查询 RR 的算术平均 */
export function mrr(perQueryRR: number[]): number {
  if (perQueryRR.length === 0) return 0;
  return perQueryRR.reduce((a, b) => a + b, 0) / perQueryRR.length;
}

/** 算术平均（报告聚合用） */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
