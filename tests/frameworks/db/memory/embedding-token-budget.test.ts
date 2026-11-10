import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type DatabaseType from "better-sqlite3";
import { createTestDb } from "../../../helpers/db";
import {
  claimPendingTasks,
  enqueueRetry,
  markTaskAttemptFailed,
  pendingTaskStats,
} from "@frameworks/db/memory/embedding-task-queue";

let db: DatabaseType.Database;

beforeAll(() => { db = createTestDb(); });
afterAll(() => { db.close(); });
beforeEach(() => {
  db.exec("DELETE FROM embedding_tasks; DELETE FROM memory_vec; DELETE FROM memory_fts_jieba; DELETE FROM memory_entries;");
});

function seed(id: string, content: string): void {
  db.prepare(`
    INSERT INTO memory_entries (id, layer, content_type, source_id, source_table, granularity, content, created_at)
    VALUES (?, 'document', 'feature_chunk', ?, 'features', 'fine', ?, datetime('now'))
  `).run(id, id, content);
  enqueueRetry(db, id, new Error("pending"), 2);
}

describe("F20261110embrc token-budget claim", () => {
  it("按有序前缀领取，累计估算 token 不超过预算", () => {
    seed("token-a", "中".repeat(100));
    seed("token-b", "中".repeat(100));
    seed("token-c", "中".repeat(100));

    const claimed = claimPendingTasks(db, 50, 150);

    expect(claimed.map(task => task.entryId)).toEqual(["token-a"]);
    expect(claimed[0].attempts).toBe(1);
  });

  it("pendingTaskStats 不把 dead 计入 pending 或年龄分布", () => {
    seed("token-dead", "死信任务");
    seed("token-pending", "仍在等待的任务");
    markTaskAttemptFailed(db, "token-dead", new Error("hard"), 0);

    const stats = pendingTaskStats(db);

    expect(stats.pending).toBe(1);
    expect(stats.byPriority).toEqual({ 2: 1 });
  });

  it("单条自身超预算仍独占领取，不把文本拆开", () => {
    seed("token-large", "中".repeat(200));
    seed("token-next", "短文本");

    const claimed = claimPendingTasks(db, 50, 100);

    expect(claimed.map(task => task.entryId)).toEqual(["token-large"]);
    expect(claimed[0].content).toHaveLength(200);
  });
});
