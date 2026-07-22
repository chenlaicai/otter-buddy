import { describe, it, expect } from "vitest";
import {
  toScheduledTaskDTO,
  toExecutionDTO,
} from "@interface-adapters/http/dto/scheduled-task-dto";
import {
  makeScheduledTask,
  makeScheduledTaskExecution,
} from "../../../api/helpers";
import type { ScheduledTask, ScheduledTaskExecution } from "@entities/scheduled-task/scheduled-task";

describe("toScheduledTaskDTO", () => {
  it("正确映射实体所有字段到 DTO", () => {
    const task = makeScheduledTask({
      id: "task-1",
      conversationId: "conv-1",
      name: "Daily Reminder",
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
      body: "Remember to check in",
      talkingStonePassedTo: ["otter-1"],
      senderId: "otter-1",
      status: "active",
      consecutiveFailures: 0,
      lastTriggeredAt: "2026-07-22T09:00:00Z",
    }) as ScheduledTask;

    const nextTriggerAt = "2026-07-23T09:00:00.000Z";
    const dto = toScheduledTaskDTO(task, nextTriggerAt);

    expect(dto.id).toBe("task-1");
    expect(dto.conversationId).toBe("conv-1");
    expect(dto.name).toBe("Daily Reminder");
    expect(dto.cron).toBe("0 9 * * *");
    expect(dto.timezone).toBe("Asia/Shanghai");
    expect(dto.body).toBe("Remember to check in");
    expect(dto.talkingStonePassedTo).toEqual(["otter-1"]);
    expect(dto.senderId).toBe("otter-1");
    expect(dto.status).toBe("active");
    expect(dto.consecutiveFailures).toBe(0);
    expect(dto.lastTriggeredAt).toBe("2026-07-22T09:00:00Z");
    expect(dto.nextTriggerAt).toBe("2026-07-23T09:00:00.000Z");
  });

  it("传入 nextTriggerAt 时包含在 DTO 中", () => {
    const task = makeScheduledTask() as ScheduledTask;
    const dto = toScheduledTaskDTO(task, "2026-07-23T09:00:00.000Z");
    expect(dto.nextTriggerAt).toBe("2026-07-23T09:00:00.000Z");
  });

  it("未传入 nextTriggerAt 时 DTO 中 nextTriggerAt 为 null", () => {
    const task = makeScheduledTask() as ScheduledTask;
    const dto = toScheduledTaskDTO(task);
    expect(dto.nextTriggerAt).toBeNull();
  });
});

describe("toExecutionDTO", () => {
  it("正确映射执行记录实体所有字段到 DTO", () => {
    const execution = makeScheduledTaskExecution({
      id: "exec-1",
      taskId: "task-1",
      triggeredAt: "2026-07-22T09:00:00Z",
      completedAt: "2026-07-22T09:00:05Z",
      status: "completed",
      errorMessage: null,
      messageId: "msg-1",
      turnId: "turn-1",
    }) as ScheduledTaskExecution;

    const dto = toExecutionDTO(execution);

    expect(dto.id).toBe("exec-1");
    expect(dto.taskId).toBe("task-1");
    expect(dto.triggeredAt).toBe("2026-07-22T09:00:00Z");
    expect(dto.completedAt).toBe("2026-07-22T09:00:05Z");
    expect(dto.status).toBe("completed");
    expect(dto.errorMessage).toBeNull();
    expect(dto.messageId).toBe("msg-1");
    expect(dto.turnId).toBe("turn-1");
  });
});
