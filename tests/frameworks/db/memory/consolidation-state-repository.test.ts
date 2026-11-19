/**
 * consolidation_state 表 + SQLite 仓库单测。
 *
 * 覆盖：表建成（索引/CHECK 存在）、save upsert 幂等、getByKey 往返、
 * CHECK（半空失败区间写入被拒）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteConsolidationStateRepository } from "@frameworks/db/memory/sqlite-consolidation-state-repository";
import { newConsolidationState } from "@entities/memory/consolidation-state";

describe("SqliteConsolidationStateRepository（P2b1）", () => {
  let db: Database.Database;
  let repo: SqliteConsolidationStateRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    repo = new SqliteConsolidationStateRepository(db);
  });

  it("save + getByKey 字段全集往返", async () => {
    const state = {
      reviewKey: "review:2026-11-18:t1",
      failedAfter: "2026-11-18T00:00:00Z",
      failedThrough: "2026-11-18T06:00:00Z",
      failures: 2,
      resultJson: null,
      updatedAt: "2026-11-18T09:00:00.000Z",
    };
    await repo.save(state);
    const got = await repo.getByKey("review:2026-11-18:t1");
    expect(got).toEqual(state);
  });

  it("save 同键 upsert（幂等），不抛 UNIQUE 冲突", async () => {
    await repo.save(newConsolidationState("review:2026-11-18:t2", "2026-11-18T09:00:00.000Z"));
    await repo.save({
      ...newConsolidationState("review:2026-11-18:t2", "2026-11-18T10:00:00.000Z"),
      resultJson: "{}",
      failures: 1,
      failedAfter: "a",
      failedThrough: "b",
    });
    const got = await repo.getByKey("review:2026-11-18:t2");
    expect(got?.resultJson).toBe("{}");
    expect(got?.failures).toBe(1);
    expect(got?.updatedAt).toBe("2026-11-18T10:00:00.000Z");
  });

  it("getByKey 未命中返回 null", async () => {
    expect(await repo.getByKey("review:2026-11-18:absent")).toBeNull();
  });

  it("CHECK 拒绝半空失败区间（连败计数不可绑定无头区间）", async () => {
    const halfOpen = {
      reviewKey: "review:2026-11-18:t3",
      failedAfter: "2026-11-18T00:00:00Z",
      failedThrough: null,
      failures: 1,
      resultJson: null,
      updatedAt: "2026-11-18T09:00:00.000Z",
    };
    await expect(repo.save(halfOpen)).rejects.toThrow();
  });

  it("listByTaskId（P2b2）：只列同 taskId 的档且日期升序，含 settle 与在途", async () => {
    await repo.save(newConsolidationState("review:2026-11-17:night-review", "2026-11-17T20:00:01.000Z"));
    await repo.save({
      ...newConsolidationState("review:2026-11-18:night-review", "2026-11-18T21:00:00.000Z"),
      failedAfter: "2026-11-18T02:00:00Z",
      failedThrough: "2026-11-18T03:00:00Z",
      failures: 1,
    });
    await repo.save(newConsolidationState("review:2026-11-18:other-task", "2026-11-18T22:00:00.000Z"));
    await repo.save(newConsolidationState("review:2026-11-16:night-review", "2026-11-16T20:00:01.000Z"));

    const listed = await repo.listByTaskId("night-review");
    expect(listed.map((s) => s.reviewKey)).toEqual([
      "review:2026-11-16:night-review",
      "review:2026-11-17:night-review",
      "review:2026-11-18:night-review",
    ]);
    // 含在途失败档（未 settle）
    expect(listed[2].failedAfter).toBe("2026-11-18T02:00:00Z");
    // 无档 taskId 返回空数组
    expect(await repo.listByTaskId("absent")).toEqual([]);
  });
});