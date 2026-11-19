/**
 * 夜间审视治量状态管理 usecase。
 *
 * 消费方是 的夜间审视编排（scheduled-task 触发）。本 usecase 只回答三个问题：
 * 1. claim：这次审视是否已 settle（撞键返回原结果）？没 settle 的话，上次失败区间和连败数是什么？
 * 2. complete：成功后把变更集写进存档点，清零失败区间。
 * 3. recordFailure：失败后登记——同区间连败 +1（异区间重置），并返回是否该跳过。
 *
 * 读改写都在单实体上做（read → mutate → save），SQLite 单写者下无并发窗口。
 */
import {
  MAX_CONSECUTIVE_FAILURES,
  newConsolidationState,
  parseReviewKey,
  isOrderedFailureRange,
  type ConsolidationState,
} from "@entities/memory/consolidation-state";
import { DomainError } from "@entities/errors";
import type { ConsolidationStateRepository } from "./consolidation-state-repository";

/** claim 返回的审视取档视图 */
export interface ConsolidationClaim {
  reviewKey: string;
  /** true = 上次已成功（幂等撞键），resultJson 为原变更集，直接返回不重跑 */
  settled: boolean;
  /** 上次成功变更集（JSON）；未 settle 时为 null */
  resultJson: string | null;
  /** 上次失败区间（区间不是点）；无在途失败区间时为 null */
  failingRange: { after: string; through: string } | null;
  /** 当前失败区间的连败计数 */
  failures: number;
}

/** recordFailure 返回的记账视图 */
export interface FailureOutcome {
  failures: number;
  /** 同区间连败达阈值（MAX_CONSECUTIVE_FAILURES）——编排侧应跳过并报 healing */
  shouldSkip: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toClaim(state: ConsolidationState): ConsolidationClaim {
  const hasRange = state.failedAfter !== null && state.failedThrough !== null;
  return {
    reviewKey: state.reviewKey,
    settled: state.resultJson !== null,
    resultJson: state.resultJson,
    failingRange: hasRange
      ? { after: state.failedAfter as string, through: state.failedThrough as string }
      : null,
    failures: state.failures,
  };
}

export class ManageConsolidationState {
  constructor(private readonly repo: ConsolidationStateRepository) {}

  /** 幂等键 fail-closed：非法键直接拒（防空 taskId / 非 YYYY-MM-DD 撞上错档）。 */
  private assertKey(reviewKey: string): void {
    if (parseReviewKey(reviewKey) === null) {
      throw new DomainError(`非法审视幂等键：${JSON.stringify(reviewKey)}`, "validation");
    }
  }

  /** 幂等取档：建档（首次）或取档（已存在）。撞键（settled）返回原结果。 */
  async claim(reviewKey: string): Promise<ConsolidationClaim> {
    this.assertKey(reviewKey);
    let state = await this.repo.getByKey(reviewKey);
    if (!state) {
      state = newConsolidationState(reviewKey, nowIso());
      await this.repo.save(state);
    }
    return toClaim(state);
  }

  /**
   * 成功后写存档点：resultJson 落地 + 失败区间/连败清零（该档自此 settle）。
   * 防误用：①空结果拒绝；②已 settle 档的重入仅同内容幂等、内容不同拒绝覆盖（只允许一份成功变更集）。
   */
  async complete(reviewKey: string, resultJson: string): Promise<void> {
    this.assertKey(reviewKey);
    if (typeof resultJson !== "string" || resultJson.length === 0) {
      throw new DomainError("resultJson 必须为非空字符串（空串不是合法变更集）", "validation");
    }
    const existing = await this.repo.getByKey(reviewKey);
    if (existing && existing.resultJson !== null) {
      if (existing.resultJson === resultJson) return; // 崩溃重试的幂等重入
      throw new DomainError(`该档已 settle，拒绝覆盖第一份变更集（reviewKey=${reviewKey}）`, "conflict");
    }
    const base = existing ?? newConsolidationState(reviewKey, nowIso());
    await this.repo.save({
      ...base,
      resultJson,
      failedAfter: null,
      failedThrough: null,
      failures: 0,
      updatedAt: nowIso(),
    });
  }

  /**
   * 登记一次失败。同区间（after/through 与上次一致）连败 +1；异区间重置为 1。
   * 区间语义（不是点）：重跑只重做这个区间，换区间说明水位前移，旧连败不该追着新区间跑。
   * 防误用：已 settle 档拒绝迟到失败回报（不污染已成功档）；after/through 须合法 ISO 且不倒挂。
   */
  async recordFailure(reviewKey: string, after: string, through: string): Promise<FailureOutcome> {
    this.assertKey(reviewKey);
    if (!isOrderedFailureRange(after, through)) {
      throw new DomainError(`失败区间非法或倒挂：after=${JSON.stringify(after)} through=${JSON.stringify(through)}`, "validation");
    }
    // 统同一化到毫秒精度 canonical ISO：sameRange 用严格相等，但编排两次调用可能走不同精度来源
    // （如“00Z” vs “00.000Z”）——同刻异精度不能误判成换区间（审视）。
    const nAfter = new Date(after).toISOString();
    const nThrough = new Date(through).toISOString();
    const existing = await this.repo.getByKey(reviewKey);
    if (existing && existing.resultJson !== null) {
      throw new DomainError(`该档已 settle，拒绝迟到失败回报（reviewKey=${reviewKey}）`, "conflict");
    }
    const base = existing ?? newConsolidationState(reviewKey, nowIso());
    const sameRange = base.failedAfter === nAfter && base.failedThrough === nThrough;
    const failures = sameRange ? base.failures + 1 : 1;
    await this.repo.save({
      ...base,
      failedAfter: nAfter,
      failedThrough: nThrough,
      failures,
      updatedAt: nowIso(),
    });
    return { failures, shouldSkip: failures >= MAX_CONSECUTIVE_FAILURES };
  }
}