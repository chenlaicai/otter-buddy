import { describe, it, expect, vi } from "vitest";
import { ManageScheduledTask } from "@usecases/scheduled-task/manage-scheduled-task";
import { DomainError } from "@entities/errors";
import type {
  ScheduledTask,
  ScheduledTaskExecution,
} from "@entities/scheduled-task/scheduled-task";
import type {
  ScheduledTaskRepository,
  ListExecutionsOptions,
} from "@usecases/scheduled-task/scheduled-task-repository";

/** 创建 mock repo，带状态追踪 */
function mockRepo() {
  const storedTasks = new Map<string, ScheduledTask>();
  const storedExecutions = new Map<string, ScheduledTaskExecution[]>();

  return {
    _storedTasks: storedTasks,
    _storedExecutions: storedExecutions,
    create: vi.fn(async (task: ScheduledTask) => {
      storedTasks.set(task.id, task);
    }),
    getById: vi.fn(async (id: string) => storedTasks.get(id) ?? null),
    getByConversationId: vi.fn(async (conversationId: string) => {
      return Array.from(storedTasks.values()).filter(
        (t) => t.conversationId === conversationId,
      );
    }),
    getAllActive: vi.fn(async () => {
      return Array.from(storedTasks.values()).filter(
        (t) => t.status === "active",
      );
    }),
    update: vi.fn(async (task: ScheduledTask) => {
      storedTasks.set(task.id, task);
    }),
    updateStatus: vi.fn(async (id: string, status: string, updatedAt: string) => {
      const task = storedTasks.get(id);
      if (task) {
        task.status = status as ScheduledTask["status"];
        task.updatedAt = updatedAt;
      }
    }),
    delete: vi.fn(async (id: string) => {
      storedTasks.delete(id);
    }),
    incrementConsecutiveFailures: vi.fn(async () => 0),
    resetConsecutiveFailures: vi.fn(async () => {}),
    claimTask: vi.fn(async () => true),
    createExecution: vi.fn(async (execution: ScheduledTaskExecution) => {
      const existing = storedExecutions.get(execution.taskId) ?? [];
      existing.push(execution);
      storedExecutions.set(execution.taskId, existing);
    }),
    updateExecutionStatus: vi.fn(async () => {}),
    getExecutions: vi.fn(async (taskId: string, options?: ListExecutionsOptions) => {
      const all = storedExecutions.get(taskId) ?? [];
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? all.length;
      return all.slice(offset, offset + limit);
    }),
    getExecutionCount: vi.fn(async (taskId: string) => {
      return (storedExecutions.get(taskId) ?? []).length;
    }),
  } satisfies ScheduledTaskRepository & {
    _storedTasks: Map<string, ScheduledTask>;
    _storedExecutions: Map<string, ScheduledTaskExecution[]>;
  };
}

/** 创建一个有效的创建任务输入 */
function validInput(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: "conv-1",
    name: "每日问候",
    cron: "0 9 * * *",
    timezone: "Asia/Shanghai",
    body: "早上好！",
    talkingStonePassedTo: ["otter-1"],
    senderId: "otter-1",
    ...overrides,
  };
}

describe("ManageScheduledTask", () => {
  describe("create()", () => {
    it("有效输入 -> 创建 status='active'、consecutiveFailures=0 的任务", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);

      const task = await manager.create(validInput());

      expect(task.status).toBe("active");
      expect(task.consecutiveFailures).toBe(0);
      expect(task.name).toBe("每日问候");
      expect(task.cron).toBe("0 9 * * *");
      expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(task.createdAt).toBeTruthy();
      expect(task.updatedAt).toBeTruthy();
    });

    it("无效 cron 表达式 -> 抛出 DomainError（kind='validation'）", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);

      const err = await manager
        .create(validInput({ cron: "not-a-cron" }))
        .catch((e) => e);

      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe("validation");
      expect(err.message).toContain("cron");
    });

    it("无效时区 -> 抛出 DomainError（kind='validation'）", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);

      const err = await manager
        .create(validInput({ timezone: "Invalid/Timezone" }))
        .catch((e) => e);

      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe("validation");
      expect(err.message).toContain("timezone");
    });

    it("body 超过 10000 字符 -> 抛出 DomainError（kind='validation'）", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);

      const err = await manager
        .create(validInput({ body: "x".repeat(10001) }))
        .catch((e) => e);

      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe("validation");
      expect(err.message).toContain("body");
    });

    it("talkingStonePassedTo 为空数组 -> 抛出 DomainError（kind='validation'）", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);

      const err = await manager
        .create(validInput({ talkingStonePassedTo: [] }))
        .catch((e) => e);

      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe("validation");
      expect(err.message).toContain("talkingStonePassedTo");
    });

    it("未传 timezone 时默认为 'Asia/Shanghai'", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);

      const task = await manager.create(
        validInput({ timezone: undefined }),
      );

      expect(task.timezone).toBe("Asia/Shanghai");
    });

    it("未传 senderId 时默认为 talkingStonePassedTo 的第一个元素", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);

      const task = await manager.create(
        validInput({ senderId: undefined }),
      );

      expect(task.senderId).toBe("otter-1");
    });

    it("通知 onChange 回调 (taskId, 'created')", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);

      /** 注册回调，捕获通知状态 */
      const notifications: Array<{ taskId: string; action: string }> = [];
      manager.onChange((taskId, action) => {
        notifications.push({ taskId, action });
      });

      const task = await manager.create(validInput());

      expect(notifications).toHaveLength(1);
      expect(notifications[0].taskId).toBe(task.id);
      expect(notifications[0].action).toBe("created");
    });
  });

  describe("update()", () => {
    it("有效更新 -> 更新任务并通知回调", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);

      /** 先创建一个任务 */
      const task = await manager.create(validInput());

      /** 注册回调 */
      const notifications: Array<{ taskId: string; action: string }> = [];
      manager.onChange((taskId, action) => {
        notifications.push({ taskId, action });
      });

      /** 更新任务名称 */
      const updated = await manager.update(task.id, { name: "新名称" });

      expect(updated.name).toBe("新名称");
      expect(updated.cron).toBe("0 9 * * *"); // 其他字段不变

      /** 验证 repo 中的任务已更新 */
      const stored = repo._storedTasks.get(task.id);
      expect(stored?.name).toBe("新名称");

      /** 验证通知回调 */
      expect(notifications).toHaveLength(1);
      expect(notifications[0].taskId).toBe(task.id);
      expect(notifications[0].action).toBe("updated");
    });

    it("无效状态转换 -> 抛出 DomainError（kind='validation'）", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);

      /** 创建任务（status='active'） */
      const task = await manager.create(validInput());

      /** 尝试从 active 直接转到 active（相同状态不算转换） */
      /** 但 active -> error -> disabled 是非法的，disabled 不能直接转到 error */
      /** 先将状态改为 disabled */
      await manager.update(task.id, { status: "disabled" });

      /** disabled -> error 是非法转换 */
      const err = await manager
        .update(task.id, { status: "error" })
        .catch((e) => e);

      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe("validation");
      expect(err.message).toContain("Invalid status transition");
    });

    it("任务不存在 -> 抛出 DomainError（kind='not_found'）", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);

      const err = await manager
        .update("nonexistent", { name: "新名称" })
        .catch((e) => e);

      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe("not_found");
    });
  });

  describe("delete()", () => {
    it("删除任务并通知回调", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);

      /** 先创建一个任务 */
      const task = await manager.create(validInput());

      /** 注册回调 */
      const notifications: Array<{ taskId: string; action: string }> = [];
      manager.onChange((taskId, action) => {
        notifications.push({ taskId, action });
      });

      /** 删除任务 */
      await manager.delete(task.id);

      /** 验证 repo 中的任务已删除 */
      expect(repo._storedTasks.has(task.id)).toBe(false);

      /** 验证通知回调 */
      expect(notifications).toHaveLength(1);
      expect(notifications[0].taskId).toBe(task.id);
      expect(notifications[0].action).toBe("deleted");
    });

    it("任务不存在 -> 抛出 DomainError（kind='not_found'）", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);

      const err = await manager.delete("nonexistent").catch((e) => e);

      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe("not_found");
    });
  });

  describe("getExecutions()", () => {
    it("返回执行记录和总数", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);

      /** 先创建一个任务 */
      const task = await manager.create(validInput());

      /** 模拟 repo 中有执行记录 */
      const now = new Date().toISOString();
      repo._storedExecutions.set(task.id, [
        {
          id: "exec-1",
          taskId: task.id,
          triggeredAt: now,
          completedAt: now,
          status: "completed",
          errorMessage: null,
          messageId: "msg-1",
          turnId: "turn-1",
        },
        {
          id: "exec-2",
          taskId: task.id,
          triggeredAt: now,
          completedAt: null,
          status: "running",
          errorMessage: null,
          messageId: null,
          turnId: null,
        },
      ]);

      const result = await manager.getExecutions(task.id);

      expect(result.executions).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.executions[0].id).toBe("exec-1");
      expect(result.executions[1].id).toBe("exec-2");
    });
  });
});
