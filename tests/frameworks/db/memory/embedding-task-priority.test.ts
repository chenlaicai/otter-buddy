/**
 * F20261105embqg S2b/S3：任务队列优先级与水位闸门单测。
 *
 * 覆盖：
 * - enqueueRetry priority 写入 + ON CONFLICT 不降优先级（首入队优先级保留）
 * - claimPendingTasks 按 priority ASC, next_retry_at ASC 序认领
 * - pendingTaskCount 只数 pending（dead 不计）
 * - S3 消费端：markTaskDone 后 pendingTaskCount 递减
 *
 * lint-tests:allow-ddl——豁免理由：测试对象是 embedding_tasks 表的 SQL 语义
 * 本身，必须建真实表（与 embedding-task-gate.test.ts 同模式）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { initSchema } from "@frameworks/db/schema";
import {
  enqueueRetry,
  claimPendingTasks,
  markTaskDone,
  markTaskAttemptFailed,
  pendingTaskCount,
} from "@frameworks/db/memory/embedding-task-queue";
import { EMBED_TASK_PRIORITY } from "@usecases/memory/memory-queue";
import type DatabaseType from "better-sqlite3";

let db: DatabaseType.Database;

beforeAll(async () => {
  db = new Database(":memory:");
  await loadSqliteVec(db);
  initSchema(db);
});

afterAll(() => {
  db.close();
});

function seedEntry(id: string): void {
  db.prepare(
    "INSERT INTO memory_entries (id, layer, content_type, source_id, source_table, granularity, content, created_at) VALUES (?, 'conversation', 'message', ?, 'messages', 'entry', ?, datetime('now'))",
  ).run(id, id, `content-${id}`);
}

describe("F20261105embqg S2b：任务优先级", () => {
  it("enqueueRetry 写入 priority；默认为 1", () => {
    seedEntry("p-live");
    seedEntry("p-default");
    enqueueRetry(db, "p-live", new Error("x"), EMBED_TASK_PRIORITY.live);
    enqueueRetry(db, "p-default", new Error("x"));
    const rows = db
      .prepare("SELECT entry_id, priority FROM embedding_tasks WHERE entry_id IN ('p-live', 'p-default')")
      .all() as Array<{ entry_id: string; priority: number }>;
    expect(rows.find(r => r.entry_id === "p-live")?.priority).toBe(0);
    expect(rows.find(r => r.entry_id === "p-default")?.priority).toBe(1);
  });

  it("重复入队不更新 priority（bulk 后到不覆盖 live 已在队）", () => {
    seedEntry("p-keep");
    enqueueRetry(db, "p-keep", new Error("first"), EMBED_TASK_PRIORITY.live);
    enqueueRetry(db, "p-keep", new Error("second"), EMBED_TASK_PRIORITY.bulk);
    const row = db
      .prepare("SELECT priority, last_error FROM embedding_tasks WHERE entry_id = 'p-keep'")
      .get() as { priority: number; last_error: string };
    expect(row.priority).toBe(0); // 保留首入队优先级
    expect(row.last_error).toBe("second"); // 但 last_error 更新（新错误信息有效）
  });

  it("claim 按 priority ASC 序：live 先于 bulk 出队", () => {
    seedEntry("c-bulk-1");
    seedEntry("c-bulk-2");
    seedEntry("c-live-1");
    // bulk 先入队（时间在前），live 后入队——若排序失效 bulk 会先出。
    // 隔离：先清空任务表，防前序用例的 pending 任务混入本批 claim。
    // 注：UPDATE...RETURNING 的行序不保证与子查询排序一致（SQLite 扫描序），
    // 放用两次 claim(1) 验证真实消费顺序——消费顺序才是优先级语义的本体。
    db.prepare("DELETE FROM embedding_tasks").run();
    enqueueRetry(db, "c-bulk-1", new Error("x"), EMBED_TASK_PRIORITY.bulk);
    enqueueRetry(db, "c-bulk-2", new Error("x"), EMBED_TASK_PRIORITY.bulk);
    enqueueRetry(db, "c-live-1", new Error("x"), EMBED_TASK_PRIORITY.live);

    const first = claimPendingTasks(db, 1);
    expect(first).toHaveLength(1);
    expect(first[0].entryId).toBe("c-live-1");
    expect(first[0].priority).toBe(0);

    const second = claimPendingTasks(db, 1);
    expect(second).toHaveLength(1);
    expect(second[0].entryId).toBe("c-bulk-1"); // 同级内 next_retry_at 时间序
    expect(second[0].priority).toBe(2);
  });

  it("claim RETURNING 携带 priority 字段", () => {
    const claimed = claimPendingTasks(db, 1);
    expect(claimed.length).toBeGreaterThan(0);
    expect(typeof claimed[0].priority).toBe("number");
  });
});

describe("F20261105embqg S3：pendingTaskCount（水位闸门判据）", () => {
  it("只数 pending；markTaskDone 递减；dead 不计", () => {
    // 隔离：清空任务表，防前序用例残留干扰计数
    db.prepare("DELETE FROM embedding_tasks").run();
    seedEntry("w-1");
    seedEntry("w-2");
    seedEntry("w-3");
    enqueueRetry(db, "w-1", new Error("x"));
    enqueueRetry(db, "w-2", new Error("x"));
    enqueueRetry(db, "w-3", new Error("x"));

    const before = pendingTaskCount(db);
    expect(before).toBeGreaterThanOrEqual(3);

    markTaskDone(db, "w-1");
    expect(pendingTaskCount(db)).toBe(before - 1);

    // w-2 拉满 attempts 转 dead
    const row = db.prepare("SELECT attempts FROM embedding_tasks WHERE entry_id = 'w-2'").get() as { attempts: number };
    for (let i = row.attempts; i < 3; i++) {
      markTaskAttemptFailed(db, "w-2", new Error("boom"), 3);
      // attempts 递增需要经 claim；直接 UPDATE 模拟第 3 次失败
      db.prepare("UPDATE embedding_tasks SET attempts = ? WHERE entry_id = 'w-2'").run(i + 1);
    }
    markTaskAttemptFailed(db, "w-2", new Error("final"), 3);
    const status = db.prepare("SELECT status FROM embedding_tasks WHERE entry_id = 'w-2'").get() as { status: string };
    expect(status.status).toBe("dead");
    expect(pendingTaskCount(db)).toBe(before - 2); // dead 不计
  });
});
