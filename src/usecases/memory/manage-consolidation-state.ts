/**
 * F20261118nrcst P2b1：夜间审视治量状态管理 usecase。
 *
 * 消费方是 P2b2 的夜间审视编排（scheduled-task 触发）。本 usecase 只回答三个问题：
 * 1. claim：这次审视是否已 settle（撞键返回原结果）？没 settle 的话，上次失败区间和连败数是什么？
 * 2. complete：成功后把变更集写进存档点，清零失败区间。
 * 3. recordFailure：失败后登记——同区间连败 +1（异区间重置），并返回是否该跳过。
 *
 * 读改写都在单实体上做（read → mutate → save），SQLite 单写者下无并发窗口。
 */
import {
  MAX_CONSECUTIVE_FAILURES,
  newConsolidationState,
  type ConsolidationState,
} from "@entities/memory/consolidation-state";
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

  /** 幂等取档：建档（首次）或取档（已存在）。撞键（settled）返回原结果。 */
  async claim(reviewKey: string): Promise<ConsolidationClaim> {
    let state = await this.repo.getByKey(reviewKey);
    if (!state) {
      state = newConsolidationState(reviewKey, nowIso());
      await this.repo.save(state);
    }
    return toClaim(state);
  }

  /** 成功后写存档点：resultJson 落地 + 失败区间/连败清零（该档自此 settle）。 */
  async complete(reviewKey: string, resultJson: string): Promise<void> {
    const existing = await this.repo.getByKey(reviewKey);
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
   */
  async recordFailure(reviewKey: string, after: string, through: string): Promise<FailureOutcome> {
    const existing = await this.repo.getByKey(reviewKey);
    const base = existing ?? newConsolidationState(reviewKey, nowIso());
    const sameRange = base.failedAfter === after && base.failedThrough === through;
    const failures = sameRange ? base.failures + 1 : 1;
    await this.repo.save({
      ...base,
      failedAfter: after,
      failedThrough: through,
      failures,
      updatedAt: nowIso(),
    });
    return { failures, shouldSkip: failures >= MAX_CONSECUTIVE_FAILURES };
  }
}