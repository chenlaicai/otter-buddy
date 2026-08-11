import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteScheduledTaskRepository } from "@frameworks/db/scheduled-task/sqlite-scheduled-task-repository";
import type { ScheduledTask, ScheduledTaskExecution } from "@entities/scheduled-task/scheduled-task";

/** 创建内存 SQLite 数据库并初始化 schema */
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

/** 构造测试用 ScheduledTask 实体 */
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
    talkingStonePassedTo: ["otter-1"],
    senderId: "user-1",
    status: "active",
    consecutiveFailures: 0,
    lastTriggeredAt: null,
    createdAt: "2026-07-22T00:00:00Z",
    updatedAt: "2026-07-22T00:00:00Z",
    ...overrides,
  };
}

/** 构造测试用 ScheduledTaskExecution 实体 */
function createExecutionFixture(overrides: Partial<ScheduledTaskExecution> = {}): ScheduledTaskExecution {
  return {
    id: "exec-1",
    taskId: "task-1",
    triggeredAt: "2026-07-22T09:00:00Z",
    completedAt: null,
    status: "running",
    errorMessage: null,
    messageId: null,
    turnId: null,
    ...overrides,
  };
}

describe("SqliteScheduledTaskRepository - 任务 CRUD", () => {
  let db: Database.Database;
  let repo: SqliteScheduledTaskRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteScheduledTaskRepository(db);
    // 插入外键依赖的对话记录
    insertConversation(db, "conv-1");
    insertConversation(db, "conv-2");
  });

  afterEach(() => {
    db.close();
  });

  describe("create + getById", () => {
    it("创建后读取，所有字段保持一致", async () => {
      const task = createTaskFixture();
      await repo.create(task);

      const result = await repo.getById("task-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("task-1");
      expect(result!.conversationId).toBe("conv-1");
      expect(result!.name).toBe("每日总结");
      expect(result!.cron).toBe("0 9 * * *");
      expect(result!.timezone).toBe("Asia/Shanghai");
      expect(result!.body).toBe("请生成今日对话总结");
      expect(result!.talkingStonePassedTo).toEqual(["otter-1"]);
      expect(result!.senderId).toBe("user-1");
      expect(result!.status).toBe("active");
      expect(result!.consecutiveFailures).toBe(0);
      expect(result!.lastTriggeredAt).toBeNull();
      expect(result!.createdAt).toBe("2026-07-22T00:00:00Z");
      expect(result!.updatedAt).toBe("2026-07-22T00:00:00Z");
    });

    it("不存在的 id 返回 null", async () => {
      const result = await repo.getById("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("getByConversationId", () => {
    it("返回指定对话的所有任务", async () => {
      await repo.create(createTaskFixture({ id: "task-1", conversationId: "conv-1" }));
      await repo.create(createTaskFixture({ id: "task-2", conversationId: "conv-1" }));
      await repo.create(createTaskFixture({ id: "task-3", conversationId: "conv-2" }));

      const results = await repo.getByConversationId("conv-1");
      expect(results).toHaveLength(2);
      const ids = results.map((t) => t.id);
      expect(ids).toContain("task-1");
      expect(ids).toContain("task-2");
    });

    it("无任务时返回空数组", async () => {
      const results = await repo.getByConversationId("nonexistent-conv");
      expect(results).toEqual([]);
    });
  });

  describe("getAllActive", () => {
    it("仅返回 active 状态的任务", async () => {
      await repo.create(createTaskFixture({ id: "task-active-1", status: "active" }));
      await repo.create(createTaskFixture({ id: "task-active-2", status: "active" }));
      await repo.create(createTaskFixture({ id: "task-disabled", status: "disabled" }));
      await repo.create(createTaskFixture({ id: "task-error", status: "error" }));

      const results = await repo.getAllActive();
      expect(results).toHaveLength(2);
      const ids = results.map((t) => t.id);
      expect(ids).toContain("task-active-1");
      expect(ids).toContain("task-active-2");
    });

    it("无 active 任务时返回空数组", async () => {
      await repo.create(createTaskFixture({ id: "task-1", status: "disabled" }));

      const results = await repo.getAllActive();
      expect(results).toEqual([]);
    });
  });

  describe("update", () => {
    it("更新可变字段后读取一致", async () => {
      await repo.create(createTaskFixture());

      const updated = createTaskFixture({
        name: "新任务名",
        cron: "30 10 * * *",
        timezone: "UTC",
        body: "新的任务内容",
        status: "disabled",
        consecutiveFailures: 3,
        updatedAt: "2026-07-22T12:00:00Z",
      });
      await repo.update(updated);

      const result = await repo.getById("task-1");
      expect(result!.name).toBe("新任务名");
      expect(result!.cron).toBe("30 10 * * *");
      expect(result!.timezone).toBe("UTC");
      expect(result!.body).toBe("新的任务内容");
      expect(result!.status).toBe("disabled");
      expect(result!.consecutiveFailures).toBe(3);
      expect(result!.updatedAt).toBe("2026-07-22T12:00:00Z");
    });
  });

  describe("updateStatus", () => {
    it("修改任务状态", async () => {
      await repo.create(createTaskFixture());

      await repo.updateStatus("task-1", "error", "2026-07-22T15:00:00Z");

      const result = await repo.getById("task-1");
      expect(result!.status).toBe("error");
      expect(result!.updatedAt).toBe("2026-07-22T15:00:00Z");
    });
  });

  describe("delete", () => {
    it("删除任务后无法再获取", async () => {
      await repo.create(createTaskFixture());

      await repo.delete("task-1");

      const result = await repo.getById("task-1");
      expect(result).toBeNull();
    });
  });
});

describe("SqliteScheduledTaskRepository - 状态管理与执行记录", () => {
  let db: Database.Database;
  let repo: SqliteScheduledTaskRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteScheduledTaskRepository(db);
    // 插入外键依赖的对话记录
    insertConversation(db, "conv-1");
    insertConversation(db, "conv-2");
  });

  afterEach(() => {
    db.close();
  });

  describe("incrementConsecutiveFailures", () => {
    it("递增连续失败次数并返回新值", async () => {
      await repo.create(createTaskFixture({ consecutiveFailures: 0 }));

      const count1 = await repo.incrementConsecutiveFailures("task-1", "2026-07-22T10:00:00Z");
      expect(count1).toBe(1);

      const count2 = await repo.incrementConsecutiveFailures("task-1", "2026-07-22T11:00:00Z");
      expect(count2).toBe(2);

      const count3 = await repo.incrementConsecutiveFailures("task-1", "2026-07-22T12:00:00Z");
      expect(count3).toBe(3);
    });

    it("不存在的任务返回 0", async () => {
      const count = await repo.incrementConsecutiveFailures("nonexistent", "2026-07-22T10:00:00Z");
      expect(count).toBe(0);
    });
  });

  describe("resetConsecutiveFailures", () => {
    it("重置连续失败次数为 0", async () => {
      await repo.create(createTaskFixture({ consecutiveFailures: 5 }));

      await repo.resetConsecutiveFailures("task-1", "2026-07-22T10:00:00Z");

      const result = await repo.getById("task-1");
      expect(result!.consecutiveFailures).toBe(0);
      expect(result!.updatedAt).toBe("2026-07-22T10:00:00Z");
    });
  });

  describe("claimTask", () => {
    it("首次执行（last_triggered_at 为 NULL）时成功获取锁", async () => {
      await repo.create(createTaskFixture({ lastTriggeredAt: null }));

      const claimed = await repo.claimTask("task-1", "2026-07-22T09:00:00Z", "2026-07-22T09:00:00Z");
      expect(claimed).toBe(true);

      // 验证 last_triggered_at 已更新
      const result = await repo.getById("task-1");
      expect(result!.lastTriggeredAt).toBe("2026-07-22T09:00:00Z");
    });

    it("60 秒内重复获取返回 false（乐观锁）", async () => {
      await repo.create(createTaskFixture({ lastTriggeredAt: null }));

      // 第一次获取成功
      const first = await repo.claimTask("task-1", "2026-07-22T09:00:00Z", "2026-07-22T09:00:00Z");
      expect(first).toBe(true);

      // 30 秒后再次获取，应失败（未超过 60 秒窗口）
      const second = await repo.claimTask("task-1", "2026-07-22T09:00:30Z", "2026-07-22T09:00:30Z");
      expect(second).toBe(false);
    });

    it("恰好 60 秒时返回 false（边界：条件为严格小于，等于不算超过）", async () => {
      await repo.create(createTaskFixture({ lastTriggeredAt: null }));

      // 第一次获取成功
      await repo.claimTask("task-1", "2026-07-22T09:00:00Z", "2026-07-22T09:00:00Z");

      // 恰好 60 秒后再次获取，应失败（SQL 条件为 < 不是 <=）
      const result = await repo.claimTask("task-1", "2026-07-22T09:01:00Z", "2026-07-22T09:01:00Z");
      expect(result).toBe(false);
    });

    it("超过 60 秒后可以再次获取", async () => {
      await repo.create(createTaskFixture({ lastTriggeredAt: null }));

      // 第一次获取
      await repo.claimTask("task-1", "2026-07-22T09:00:00Z", "2026-07-22T09:00:00Z");

      // 61 秒后再次获取，应成功
      const result = await repo.claimTask("task-1", "2026-07-22T09:01:01Z", "2026-07-22T09:01:01Z");
      expect(result).toBe(true);
    });

    it("非 active 状态的任务无法获取锁", async () => {
      await repo.create(createTaskFixture({ status: "disabled", lastTriggeredAt: null }));

      const claimed = await repo.claimTask("task-1", "2026-07-22T09:00:00Z", "2026-07-22T09:00:00Z");
      expect(claimed).toBe(false);
    });
  });

  describe("createExecution + getExecutions", () => {
    it("创建执行记录后可查询到", async () => {
      await repo.create(createTaskFixture());

      const execution = createExecutionFixture();
      await repo.createExecution(execution);

      const results = await repo.getExecutions("task-1");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("exec-1");
      expect(results[0].taskId).toBe("task-1");
      expect(results[0].status).toBe("running");
      expect(results[0].triggeredAt).toBe("2026-07-22T09:00:00Z");
    });

    it("按时间倒序返回执行记录", async () => {
      await repo.create(createTaskFixture());

      await repo.createExecution(createExecutionFixture({
        id: "exec-early",
        triggeredAt: "2026-07-22T08:00:00Z",
      }));
      await repo.createExecution(createExecutionFixture({
        id: "exec-late",
        triggeredAt: "2026-07-22T10:00:00Z",
      }));

      const results = await repo.getExecutions("task-1");
      expect(results).toHaveLength(2);
      // 倒序：最新的在前
      expect(results[0].id).toBe("exec-late");
      expect(results[1].id).toBe("exec-early");
    });

    it("支持分页查询", async () => {
      await repo.create(createTaskFixture());

      for (let i = 0; i < 5; i++) {
        await repo.createExecution(createExecutionFixture({
          id: `exec-${i}`,
          triggeredAt: `2026-07-22T0${i}:00:00Z`,
        }));
      }

      // 获取第 2 条开始的 2 条记录
      const results = await repo.getExecutions("task-1", { limit: 2, offset: 1 });
      expect(results).toHaveLength(2);
    });
  });

  describe("getExecutionCount", () => {
    it("返回正确的执行记录数量", async () => {
      await repo.create(createTaskFixture());

      expect(await repo.getExecutionCount("task-1")).toBe(0);

      await repo.createExecution(createExecutionFixture({ id: "exec-1" }));
      expect(await repo.getExecutionCount("task-1")).toBe(1);

      await repo.createExecution(createExecutionFixture({ id: "exec-2" }));
      expect(await repo.getExecutionCount("task-1")).toBe(2);
    });

    it("无执行记录时返回 0", async () => {
      expect(await repo.getExecutionCount("nonexistent-task")).toBe(0);
    });
  });

  describe("updateExecutionStatus", () => {
    it("更新执行记录状态为 completed", async () => {
      await repo.create(createTaskFixture());
      await repo.createExecution(createExecutionFixture());

      await repo.updateExecutionStatus("exec-1", {
        status: "completed",
        completedAt: "2026-07-22T09:05:00Z",
      });

      const results = await repo.getExecutions("task-1");
      expect(results[0].status).toBe("completed");
      expect(results[0].completedAt).toBe("2026-07-22T09:05:00Z");
    });

    it("更新执行记录状态为 failed 并记录错误信息", async () => {
      await repo.create(createTaskFixture());
      await repo.createExecution(createExecutionFixture());

      await repo.updateExecutionStatus("exec-1", {
        status: "failed",
        completedAt: "2026-07-22T09:05:00Z",
        errorMessage: "执行超时",
      });

      const results = await repo.getExecutions("task-1");
      expect(results[0].status).toBe("failed");
      expect(results[0].errorMessage).toBe("执行超时");
    });
  });
});
