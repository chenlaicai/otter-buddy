import { describe, it, expect, beforeEach } from "vitest";
import {
  createTestApp,
  json,
  createMockDeps,
  makeScheduledTask,
  makeScheduledTaskExecution,
} from "./helpers";
import type { TestDeps } from "./helpers";
import { DomainError } from "../../src/entities/errors";

describe("Scheduled Task API", () => {
  let deps: TestDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  // ─── POST /api/conversations/:id/scheduled-tasks ───

  describe("POST /api/conversations/:id/scheduled-tasks", () => {
    it("创建定时任务并返回 201 及 DTO（含 nextTriggerAt）", async () => {
      const task = makeScheduledTask({ id: "task-new" });
      deps.manageScheduledTask.create.mockResolvedValue(task);
      deps.cronParser.getNextTime.mockReturnValue(
        new Date("2026-07-23T09:00:00Z"),
      );

      const res = await app.request(
        "/api/conversations/conv-1/scheduled-tasks",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Daily Reminder",
            cron: "0 9 * * *",
            body: "Remember to check in",
            talkingStonePassedTo: ["otter-1"],
          }),
        },
      );

      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.id).toBe("task-new");
      expect(body.name).toBe("Daily Reminder");
      expect(body.nextTriggerAt).toBe("2026-07-23T09:00:00.000Z");
    });

    it("创建 once 类型任务时使用 triggerAt 作为 nextTriggerAt", async () => {
      const task = makeScheduledTask({
        id: "task-once",
        scheduleType: "once",
        cron: "",
        triggerAt: "2026-07-23T10:50:00+08:00",
      });
      deps.manageScheduledTask.create.mockResolvedValue(task);

      const res = await app.request(
        "/api/conversations/conv-1/scheduled-tasks",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "One-time Reminder",
            scheduleType: "once",
            triggerAt: "2026-07-23T10:50:00+08:00",
            body: "Drink water",
            talkingStonePassedTo: ["otter-1"],
          }),
        },
      );

      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.id).toBe("task-once");
      expect(body.scheduleType).toBe("once");
      expect(body.triggerAt).toBe("2026-07-23T10:50:00+08:00");
      expect(body.nextTriggerAt).toBe("2026-07-23T10:50:00+08:00");
      // cron parser 不应被调用
      expect(deps.cronParser.getNextTime).not.toHaveBeenCalled();
      // 验证 create 请求字段正确转发到 use case
      expect(deps.manageScheduledTask.create).toHaveBeenCalledWith({
        conversationId: "conv-1",
        name: "One-time Reminder",
        scheduleType: "once",
        triggerAt: "2026-07-23T10:50:00+08:00",
        body: "Drink water",
        talkingStonePassedTo: ["otter-1"],
        senderId: undefined,
      });
    });

    it("use case 抛出 DomainError 时返回 400", async () => {
      deps.manageScheduledTask.create.mockRejectedValue(
        new DomainError("Invalid cron expression", "validation"),
      );

      const res = await app.request(
        "/api/conversations/conv-1/scheduled-tasks",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Bad Task",
            cron: "invalid",
            body: "test",
            talkingStonePassedTo: ["otter-1"],
          }),
        },
      );

      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain("Invalid cron");
    });
  });

  // ─── GET /api/conversations/:id/scheduled-tasks ───

  describe("GET /api/conversations/:id/scheduled-tasks", () => {
    it("返回任务列表，每个任务包含 nextTriggerAt", async () => {
      const task = makeScheduledTask();
      deps.manageScheduledTask.getByConversationId.mockResolvedValue([task]);
      deps.cronParser.getNextTime.mockReturnValue(
        new Date("2026-07-23T09:00:00Z"),
      );

      const res = await app.request(
        "/api/conversations/conv-1/scheduled-tasks",
      );

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("task-1");
      expect(body[0].nextTriggerAt).toBe("2026-07-23T09:00:00.000Z");
    });

    it("列表中包含 once 类型任务时不调用 cronParser", async () => {
      const cronTask = makeScheduledTask({ id: "task-cron" });
      const onceTask = makeScheduledTask({
        id: "task-once",
        scheduleType: "once",
        cron: "",
        triggerAt: "2026-07-23T10:50:00+08:00",
      });
      deps.manageScheduledTask.getByConversationId.mockResolvedValue([cronTask, onceTask]);
      deps.cronParser.getNextTime.mockReturnValue(
        new Date("2026-07-23T09:00:00Z"),
      );

      const res = await app.request(
        "/api/conversations/conv-1/scheduled-tasks",
      );

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toHaveLength(2);
      // cron 任务调用 cronParser，once 任务不调用
      expect(deps.cronParser.getNextTime).toHaveBeenCalledOnce();
      expect(body[1].scheduleType).toBe("once");
      expect(body[1].triggerAt).toBe("2026-07-23T10:50:00+08:00");
      expect(body[1].nextTriggerAt).toBe("2026-07-23T10:50:00+08:00");
    });
  });

  // ─── GET /api/scheduled-tasks/:taskId ───

  describe("GET /api/scheduled-tasks/:taskId", () => {
    it("返回指定任务详情", async () => {
      const task = makeScheduledTask({ id: "task-abc" });
      deps.manageScheduledTask.getById.mockResolvedValue(task);
      deps.cronParser.getNextTime.mockReturnValue(
        new Date("2026-07-23T09:00:00Z"),
      );

      const res = await app.request("/api/scheduled-tasks/task-abc");

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.id).toBe("task-abc");
      expect(body.nextTriggerAt).toBe("2026-07-23T09:00:00.000Z");
    });

    it("任务不存在时返回 404", async () => {
      deps.manageScheduledTask.getById.mockResolvedValue(null);

      const res = await app.request("/api/scheduled-tasks/missing");

      expect(res.status).toBe(404);
      const body = await json(res);
      expect(body.error).toContain("not found");
    });
  });

  // ─── PATCH /api/scheduled-tasks/:taskId ───

  describe("PATCH /api/scheduled-tasks/:taskId", () => {
    it("更新任务并返回更新后的 DTO", async () => {
      const updated = makeScheduledTask({ id: "task-1", name: "Updated" });
      deps.manageScheduledTask.update.mockResolvedValue(updated);
      deps.cronParser.getNextTime.mockReturnValue(
        new Date("2026-07-23T09:00:00Z"),
      );

      const res = await app.request("/api/scheduled-tasks/task-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      });

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.name).toBe("Updated");
    });

    it("任务不存在时返回 404", async () => {
      deps.manageScheduledTask.update.mockRejectedValue(
        new DomainError("ScheduledTask not found: missing", "not_found"),
      );

      const res = await app.request("/api/scheduled-tasks/missing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      });

      expect(res.status).toBe(404);
    });
  });

  // ─── DELETE /api/scheduled-tasks/:taskId ───

  describe("DELETE /api/scheduled-tasks/:taskId", () => {
    it("删除任务并返回成功状态", async () => {
      deps.manageScheduledTask.delete.mockResolvedValue(undefined);

      const res = await app.request("/api/scheduled-tasks/task-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.status).toBe("deleted");
    });

    it("任务不存在时返回 404", async () => {
      deps.manageScheduledTask.delete.mockRejectedValue(
        new DomainError("ScheduledTask not found: missing", "not_found"),
      );

      const res = await app.request("/api/scheduled-tasks/missing", {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
    });
  });

  // ─── POST /api/scheduled-tasks/:taskId/trigger ───

  describe("POST /api/scheduled-tasks/:taskId/trigger", () => {
    it("触发任务并返回 executionId", async () => {
      deps.schedulerService.trigger.mockResolvedValue({
        executionId: "exec-new",
      });

      const res = await app.request(
        "/api/scheduled-tasks/task-1/trigger",
        { method: "POST" },
      );

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.executionId).toBe("exec-new");
    });
  });

  // ─── GET /api/scheduled-tasks/:taskId/executions ───

  describe("GET /api/scheduled-tasks/:taskId/executions", () => {
    it("返回执行历史列表", async () => {
      const execution = makeScheduledTaskExecution({ id: "exec-1" });
      deps.manageScheduledTask.getExecutions.mockResolvedValue({
        executions: [execution],
        total: 1,
      });

      const res = await app.request(
        "/api/scheduled-tasks/task-1/executions",
      );

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.executions).toHaveLength(1);
      expect(body.executions[0].id).toBe("exec-1");
      expect(body.total).toBe(1);
      expect(body.limit).toBe(20);
      expect(body.offset).toBe(0);
    });

    it("分页参数无效时返回 400", async () => {
      const res = await app.request(
        "/api/scheduled-tasks/task-1/executions?limit=abc",
      );

      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain("Invalid pagination parameters");
    });
  });
});
