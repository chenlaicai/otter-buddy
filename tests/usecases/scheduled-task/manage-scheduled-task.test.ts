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

    describe("once 类型任务", () => {
      it("scheduleType='once' + 有效 triggerAt -> 创建 once 任务", async () => {
        const repo = mockRepo();
        const manager = new ManageScheduledTask(repo);

        const task = await manager.create(validInput({
          scheduleType: "once",
          triggerAt: "2026-08-11T17:00:00+08:00",
          cron: undefined,
        }));

        expect(task.scheduleType).toBe("once");
        expect(task.triggerAt).toBe("2026-08-11T17:00:00+08:00");
        expect(task.cron).toBe("");
      });

      it("scheduleType='once' 但无 triggerAt -> 抛出 DomainError", async () => {
        const repo = mockRepo();
        const manager = new ManageScheduledTask(repo);

        const err = await manager
          .create(validInput({ scheduleType: "once", cron: undefined }))
          .catch((e) => e);

        expect(err).toBeInstanceOf(DomainError);
        expect(err.kind).toBe("validation");
      });

      it("默认 scheduleType='cron'（向后兼容）", async () => {
        const repo = mockRepo();
        const manager = new ManageScheduledTask(repo);

        const task = await manager.create(validInput());

        expect(task.scheduleType).toBe("cron");
        expect(task.triggerAt).toBeNull();
      });
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

  // #610: watchlist-only patch 语义
  describe("watchlist patch", () => {
    /** 复刻生产体 #610：{prompt, watchlist} 全文 JSON body */
    const productionBody = JSON.stringify({
      prompt: "# 操盘獭每日任务\n\n...81 行全文...",
      watchlist: ["600519", "000001", "300750"],
    });

    it("watchlist-only patch -> 只替换 watchlist，prompt 原样保留", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);
      const task = await manager.create(validInput({ body: productionBody }));

      const updated = await manager.update(task.id, { watchlist: ["601318", "600519"] });

      // prompt 未被动过，watchlist 已替换，其他字段不回调调用方携带
      const parsed = JSON.parse(updated.body);
      expect(parsed.prompt).toBe("# 操盘獭每日任务\n\n...81 行全文...");
      expect(parsed.watchlist).toEqual(["601318", "600519"]);
      expect(updated.name).toBe("每日问候");
      // 通知回调仍触发（调度器 timer 重建依赖它）
      const stored = repo._storedTasks.get(task.id);
      expect(stored && JSON.parse(stored.body).watchlist).toEqual(["601318", "600519"]);
    });

    it("旧 body 非 JSON（纯文本任务）-> 拒绝 patch，不清空原 body", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);
      const task = await manager.create(validInput({ body: "早上好！" }));

      const err = await manager
        .update(task.id, { watchlist: ["601318"] })
        .catch((e) => e);

      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe("validation");
      // 原任务未被破坏
      const stored = repo._storedTasks.get(task.id);
      expect(stored?.body).toBe("早上好！");
    });

    it("旧 body 是 JSON 数组/标量 -> 同样拒绝 patch", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);
      const task = await manager.create(validInput({ body: "[1,2,3]" }));

      const err = await manager
        .update(task.id, { watchlist: ["601318"] })
        .catch((e) => e);

      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe("validation");
    });

    it("watchlist 与 body 同时携带 -> 拒绝（语义互斥）", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);
      const task = await manager.create(validInput({ body: productionBody }));

      const err = await manager
        .update(task.id, { watchlist: ["601318"], body: productionBody })
        .catch((e) => e);

      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe("validation");
      expect(err.message).toContain("mutually exclusive");
    });

    it("watchlist 含非字符串元素 -> 拒绝", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);
      const task = await manager.create(validInput({ body: productionBody }));

      const err = await manager
        // @ts-expect-error 故意传非法结构验证运行时校验
        .update(task.id, { watchlist: [601318] })
        .catch((e) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe("validation");
    });

    it("watchlist 为空数组 -> 合法（清空自选池，操盘 prompt 对空池有明确行为）", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);
      const task = await manager.create(validInput({ body: productionBody }));

      const updated = await manager.update(task.id, { watchlist: [] });

      expect(JSON.parse(updated.body).watchlist).toEqual([]);
      expect(JSON.parse(updated.body).prompt).toBe("# 操盘獭每日任务\n\n...81 行全文...");
    });

    it("patched body 超 10000 上限 -> 拒绝（不变量对齐）", async () => {
      const repo = mockRepo();
      const manager = new ManageScheduledTask(repo);
      // prompt 9950 字符 + watchlist 序列化后越界
      const longPrompt = "a".repeat(9950);
      const task = await manager.create(
        validInput({ body: JSON.stringify({ prompt: longPrompt, watchlist: ["600519"] }) }),
      );

      const err = await manager
        .update(task.id, { watchlist: ["601318", "600036", "000858", "300750"] })
        .catch((e) => e);

      expect(err).toBeInstanceOf(DomainError);
      // 检视发现 1：报错需区分 patch 路径（合并 watchlist 后溢出）与旧通道 body 超限
      expect(err.message).toContain("patched body");
      expect(err.message).toContain("10000");
    });
  });
});

// ─── #516: timeoutMinutes 任务级超时配置 ────────────────────

describe("#516: timeoutMinutes 任务级超时配置", () => {
  it("create 传入 timeoutMinutes -> 持久化到任务", async () => {
    const repo = mockRepo();
    const uc = new ManageScheduledTask(repo);

    const task = await uc.create({
      conversationId: "conv-1",
      name: "每日 issue 处理",
      cron: "30 10 * * *",
      body: "处理 issue",
      timeoutMinutes: 240,
      talkingStonePassedTo: ["otter-1"],
    });

    expect(task.timeoutMinutes).toBe(240);
  });

  it("create 未传 timeoutMinutes -> 默认 null（用调度器默认 15 分钟）", async () => {
    const repo = mockRepo();
    const uc = new ManageScheduledTask(repo);

    const task = await uc.create({
      conversationId: "conv-1",
      name: "健康检查",
      cron: "0 10 * * *",
      body: "检查",
      talkingStonePassedTo: ["otter-1"],
    });

    expect(task.timeoutMinutes).toBeNull();
  });

  it("create timeoutMinutes 非法（0/负数/小数/超 1440）-> 抛 DomainError", async () => {
    const repo = mockRepo();
    const uc = new ManageScheduledTask(repo);

    for (const bad of [0, -5, 1.5, 1441]) {
      const err = await uc.create({
        conversationId: "conv-1",
        name: "t",
        cron: "0 9 * * *",
        body: "b",
        timeoutMinutes: bad,
        talkingStonePassedTo: ["otter-1"],
      }).catch(e => e);
      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe("validation");
    }
  });

  it("update 修改 timeoutMinutes -> 生效；传 null 清除回默认", async () => {
    const repo = mockRepo();
    const uc = new ManageScheduledTask(repo);

    const task = await uc.create({
      conversationId: "conv-1",
      name: "t",
      cron: "0 9 * * *",
      body: "b",
      timeoutMinutes: 120,
      talkingStonePassedTo: ["otter-1"],
    });

    const updated = await uc.update(task.id, { timeoutMinutes: 480 });
    expect(updated.timeoutMinutes).toBe(480);

    const cleared = await uc.update(task.id, { timeoutMinutes: null });
    expect(cleared.timeoutMinutes).toBeNull();
  });

  it("update 不传 timeoutMinutes -> 保留原值", async () => {
    const repo = mockRepo();
    const uc = new ManageScheduledTask(repo);

    const task = await uc.create({
      conversationId: "conv-1",
      name: "t",
      cron: "0 9 * * *",
      body: "b",
      timeoutMinutes: 90,
      talkingStonePassedTo: ["otter-1"],
    });

    const updated = await uc.update(task.id, { name: "renamed" });
    expect(updated.timeoutMinutes).toBe(90);
  });
});
