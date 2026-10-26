/**
 * F20261026emct：embedding 队列垃圾出清单测。
 *
 * 覆盖：
 * - enqueueRetry 前置校验：entry 不存在 / content 空白 → no-op 不入队；
 *   正常 entry → 入队（ON CONFLICT 复活语义保留）
 * - purgeGhostTasks / countGhostTasks：只清 last_error LIKE '%entry deleted%'
 *   的 pending/dead，其它形态不动
 * - resetPendingAttempts：只重置 pending（语义锁定，防未来误改带 dead）
 *
 * lint-tests:allow-ddl——豁免理由：测试对象是 embedding_tasks 表的 SQL 语义
 * 本身，必须建真实表（与 tests/frameworks/db/migration.test.ts 同模式）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { initSchema } from "@frameworks/db/schema";
import {
  enqueueRetry,
  purgeGhostTasks,
  countGhostTasks,
  resetPendingAttempts,
} from "@frameworks/db/memory/embedding-task-queue";
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

function insertEntry(id: string, content: string): void {
  db.prepare(`
    INSERT INTO memory_entries (id, layer, content_type, source_id, source_table, granularity, content, created_at)
    VALUES (?, 'raw', 'message', ?, 'message', 'conversation', ?, datetime('now'))
  `).run(id, `src-${id}`, content);
}

function taskRow(entryId: string) {
  return db.prepare("SELECT * FROM embedding_tasks WHERE entry_id = ?").get(entryId) as
    | { status: string; attempts: number; last_error: string | null }
    | undefined;
}

describe("enqueueRetry 前置校验（F20261026emct 幽灵任务断源）", () => {
  it("entry 不存在 → no-op（此前会插幽灵任务行，claim 永远 'entry deleted' 空转）", () => {
    enqueueRetry(db, "ghost-id", new Error("any error"));
    expect(taskRow("ghost-id")).toBeUndefined();
  });

  it("content 为空白 → no-op", () => {
    insertEntry("blank-entry", "   ");
    enqueueRetry(db, "blank-entry", new Error("any error"));
    expect(taskRow("blank-entry")).toBeUndefined();
  });

  it("content 为空串 → no-op", () => {
    insertEntry("empty-entry", "");
    enqueueRetry(db, "empty-entry", new Error("any error"));
    expect(taskRow("empty-entry")).toBeUndefined();
  });

  it("正常 entry → 入队（status=pending）", () => {
    insertEntry("live-entry", "真内容");
    enqueueRetry(db, "live-entry", new Error("timeout"));
    const row = taskRow("live-entry");
    expect(row).toBeDefined();
    expect(row!.status).toBe("pending");
    expect(row!.last_error).toBe("timeout");
  });

  it("ON CONFLICT 复活语义保留：dead 任务被重新入队后回到 pending", () => {
    insertEntry("revive-entry", "复活内容");
    enqueueRetry(db, "revive-entry", new Error("first"));
    db.prepare("UPDATE embedding_tasks SET status = 'dead' WHERE entry_id = ?").run("revive-entry");
    enqueueRetry(db, "revive-entry", new Error("second"));
    expect(taskRow("revive-entry")!.status).toBe("pending");
  });
});

describe("purgeGhostTasks / countGhostTasks（F20261026emct 存量出清，delta 口径修正：真定义 entry NOT EXISTS）", () => {
  it("entry 已删的任务全清（无论 last_error 形态）；entry 存活的任务不动", () => {
    // 造 3 条孤儿（entry 不存在：2 幽灵 + 1 超时残骸，delta 实锤形态：batch timeout 巨批）
    // + 1 条正常 pending（entry 存活——normal-1 必须有 entry 行，否则它自己就是孤儿）
    db.exec("DELETE FROM embedding_tasks");
    insertEntry("normal-1", "存活内容");
    db.prepare(`
      INSERT INTO embedding_tasks (entry_id, next_retry_at, status, attempts, created_at, last_error)
      VALUES
        ('ghost-1', datetime('now'), 'pending', 1, datetime('now'), 'entry deleted (content join failed)'),
        ('ghost-2', datetime('now'), 'dead', 3, datetime('now'), 'embed failed: entry deleted'),
        ('ghost-3', datetime('now'), 'pending', 2, datetime('now'), 'Embed batch timeout after 120000ms (49 texts)'),
        ('normal-1', datetime('now'), 'pending', 0, datetime('now'), NULL)
    `).run();

    expect(countGhostTasks(db)).toBe(3);
    const deleted = purgeGhostTasks(db);
    expect(deleted).toBe(3);
    expect(countGhostTasks(db)).toBe(0);
    // entry 存活的任务保留（正常在途/可重试）
    expect(taskRow("normal-1")).toBeDefined();
    expect(taskRow("ghost-1")).toBeUndefined();
    expect(taskRow("ghost-2")).toBeUndefined();
    expect(taskRow("ghost-3")).toBeUndefined();
  });

  it("清理是行级操作：memory_entries 不受影响", () => {
    db.exec("DELETE FROM embedding_tasks");
    insertEntry("kept-entry", "保留内容");
    db.prepare(`
      INSERT INTO embedding_tasks (entry_id, next_retry_at, status, created_at, last_error)
      VALUES
        ('orphan-x', datetime('now'), 'dead', datetime('now'), 'entry deleted'),
        ('kept-entry', datetime('now'), 'pending', datetime('now'), NULL)
    `).run();
    purgeGhostTasks(db);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE id = 'kept-entry'").get(),
    ).toEqual({ n: 1 });
    // kept-entry 自己的任务不动（entry 存活）
    expect(taskRow("kept-entry")).toBeDefined();
    expect(taskRow("orphan-x")).toBeUndefined();
  });
});

describe("resetPendingAttempts（语义锁定）", () => {
  it("只重置 pending 且 attempts>0，dead 不赦免", () => {
    db.exec("DELETE FROM embedding_tasks");
    db.prepare(`
      INSERT INTO embedding_tasks (entry_id, next_retry_at, status, attempts, created_at, last_error)
      VALUES
        ('p-amnesty', datetime('now'), 'pending', 3, datetime('now'), 'x'),
        ('d-keep', datetime('now'), 'dead', 3, datetime('now'), 'x')
    `).run();
    const changes = resetPendingAttempts(db);
    expect(changes).toBe(1);
    expect(taskRow("p-amnesty")!.attempts).toBe(0);
    expect(taskRow("d-keep")!.attempts).toBe(3);
  });
});
