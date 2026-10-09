import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteScheduledTaskRepository } from "@frameworks/db/scheduled-task/sqlite-scheduled-task-repository";
import type { ScheduledTask } from "@entities/scheduled-task/scheduled-task";

/** #1391：scheduled-task 仓 updateStatus 对不存在 ID fail-closed（#1370 族模式收尾） */

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

/** 插入测试用对话（外键依赖） */
function insertConversation(db: Database.Database, id: string): void {
  db.prepare(`
    INSERT INTO conversations (id, title, created_at, updated_at)
    VALUES (?, 'test-conversation', '2026-07-22T00:00:00Z', '2026-07-22T00:00:00Z')
  `).run(id);
}

function createTaskFixture(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    conversationId: "conv-1",
    name: "每日总结",
    scheduleType: "cron",
    cron: "0 9 * * *",
    triggerAt: null,
    timezone: "Asia/Shanghai",
    body: "请生成今日对话总结",
    description: null,
    talkingStonePassedTo: ["otter-1"],
    senderId: "user-1",
    status: "active",
    consecutiveFailures: 0,
    lastTriggeredAt: null,
    restartBeforeInvoke: false,
    timeoutMinutes: null,
    executorType: "agent",
    createdAt: "2026-07-22T00:00:00Z",
    updatedAt: "2026-07-22T00:00:00Z",
    ...overrides,
  };
}

describe("SqliteScheduledTaskRepository.updateStatus fail-closed（#1391）", () => {
  let db: Database.Database;
  let repo: SqliteScheduledTaskRepository;

  beforeEach(() => {
    db = createTestDb();
    insertConversation(db, "conv-1");
    repo = new SqliteScheduledTaskRepository(db);
  });
  afterEach(() => { db.close(); });

  it("不存在的 ID：抛错（changes=0 不静默成功）", async () => {
    await expect(repo.updateStatus("task-nonexistent", "error", "2026-10-09T00:00:00Z"))
      .rejects.toThrow(/scheduled task 不存在/);
  });

  it("存在的 ID：正常更新不回归", async () => {
    await repo.create(createTaskFixture());
    await repo.updateStatus("task-1", "disabled", "2026-10-09T00:00:00Z");
    const task = await repo.getById("task-1");
    expect(task?.status).toBe("disabled");
  });
});
