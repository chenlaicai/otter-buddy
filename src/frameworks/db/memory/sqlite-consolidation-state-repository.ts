/**
 * SqliteConsolidationStateRepository：夜间审视治量状态仓库实现。
 *
 * 表结构见 schema.ts consolidation_state。
 * 表形态是幂等键一行一档；save 走 INSERT OR REPLACE 全量 upsert。
 */

import type Database from "better-sqlite3";
import { parseReviewKey, type ConsolidationState } from "@entities/memory/consolidation-state";
import type { ConsolidationStateRepository } from "@usecases/memory/consolidation-state-repository";

interface ConsolidationStateRow {
  review_key: string;
  failed_after: string | null;
  failed_through: string | null;
  failures: number;
  result_json: string | null;
  updated_at: string;
}

function rowToState(row: ConsolidationStateRow): ConsolidationState {
  return {
    reviewKey: row.review_key,
    failedAfter: row.failed_after,
    failedThrough: row.failed_through,
    failures: row.failures,
    resultJson: row.result_json,
    updatedAt: row.updated_at,
  };
}

export class SqliteConsolidationStateRepository implements ConsolidationStateRepository {
  constructor(private readonly db: Database.Database) {}

  async getByKey(reviewKey: string): Promise<ConsolidationState | null> {
    const row = this.db.prepare(
      "SELECT * FROM consolidation_state WHERE review_key = ?",
    ).get(reviewKey) as ConsolidationStateRow | undefined;
    return row ? rowToState(row) : null;
  }

  async save(state: ConsolidationState): Promise<void> {
    this.db.prepare(`
      INSERT INTO consolidation_state (
        review_key, failed_after, failed_through, failures, result_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(review_key) DO UPDATE SET
        failed_after = excluded.failed_after,
        failed_through = excluded.failed_through,
        failures = excluded.failures,
        result_json = excluded.result_json,
        updated_at = excluded.updated_at
    `).run(
      state.reviewKey,
      state.failedAfter,
      state.failedThrough,
      state.failures,
      state.resultJson,
      state.updatedAt,
    );
  }

  /**
   * 列指定 taskId 的全部档，日期升序。全表读出后用 parseReviewKey 内存过滤
   * （表一天一行量级；不用的 LIKE 前缀匹配规避 taskId 含通配符的误匹配面）。
   */
  async listByTaskId(taskId: string): Promise<ConsolidationState[]> {
    const rows = this.db.prepare(
      "SELECT review_key FROM consolidation_state",
    ).all() as Array<{ review_key: string }>;
    const keys = rows
      .map((r) => r.review_key)
      .map((key) => parseReviewKey(key))
      .filter((p): p is { date: string; taskId: string } => p !== null && p.taskId === taskId)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const states: ConsolidationState[] = [];
    for (const { date } of keys) {
      const state = await this.getByKey(`review:${date}:${taskId}`);
      if (state) states.push(state);
    }
    return states;
  }
}