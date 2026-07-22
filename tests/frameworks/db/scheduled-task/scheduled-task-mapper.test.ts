import { describe, it, expect } from "vitest";
import {
  rowToScheduledTask,
  rowToExecution,
  taskToRow,
} from "@frameworks/db/scheduled-task/scheduled-task-mapper";
import type {
  ScheduledTaskRow,
  ScheduledTaskExecutionRow,
} from "@frameworks/db/scheduled-task/scheduled-task-mapper";
import type { ScheduledTask } from "@entities/scheduled-task/scheduled-task";

describe("rowToScheduledTask", () => {
  const baseRow: ScheduledTaskRow = {
    id: "task-1",
    conversation_id: "conv-1",
    name: "每日摘要",
    cron: "0 9 * * *",
    timezone: "Asia/Shanghai",
    body: "生成今日摘要",
    talking_stone_passed_to: '["otter-1"]',
    sender_id: "otter-1",
    status: "active",
    consecutive_failures: 0,
    last_triggered_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  it("将 snake_case 行映射为 camelCase 实体", () => {
    const result = rowToScheduledTask(baseRow);

    expect(result.id).toBe("task-1");
    expect(result.conversationId).toBe("conv-1");
    expect(result.name).toBe("每日摘要");
    expect(result.cron).toBe("0 9 * * *");
    expect(result.timezone).toBe("Asia/Shanghai");
    expect(result.body).toBe("生成今日摘要");
    expect(result.senderId).toBe("otter-1");
    expect(result.status).toBe("active");
    expect(result.consecutiveFailures).toBe(0);
    expect(result.lastTriggeredAt).toBeNull();
    expect(result.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(result.updatedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("talking_stone_passed_to 通过 JSON.parse 解析为数组", () => {
    const row: ScheduledTaskRow = {
      ...baseRow,
      talking_stone_passed_to: '["otter-1","otter-2"]',
    };

    const result = rowToScheduledTask(row);
    expect(result.talkingStonePassedTo).toEqual(["otter-1", "otter-2"]);
  });

  it("talking_stone_passed_to 为空数组 JSON 时解析为空数组", () => {
    const row: ScheduledTaskRow = {
      ...baseRow,
      talking_stone_passed_to: "[]",
    };

    const result = rowToScheduledTask(row);
    expect(result.talkingStonePassedTo).toEqual([]);
  });

  it("talking_stone_passed_to JSON 解析失败时回退为空数组", () => {
    const row: ScheduledTaskRow = {
      ...baseRow,
      talking_stone_passed_to: "这不是合法JSON",
    };

    const result = rowToScheduledTask(row);
    expect(result.talkingStonePassedTo).toEqual([]);
  });

  it("talking_stone_passed_to 解析为非数组时回退为空数组", () => {
    const row: ScheduledTaskRow = {
      ...baseRow,
      talking_stone_passed_to: '{"key":"value"}',
    };

    const result = rowToScheduledTask(row);
    expect(result.talkingStonePassedTo).toEqual([]);
  });

  it("last_triggered_at 有值时正确映射", () => {
    const row: ScheduledTaskRow = {
      ...baseRow,
      last_triggered_at: "2026-01-02T09:00:00Z",
    };

    const result = rowToScheduledTask(row);
    expect(result.lastTriggeredAt).toBe("2026-01-02T09:00:00Z");
  });

  it("error 状态正确映射", () => {
    const row: ScheduledTaskRow = {
      ...baseRow,
      status: "error",
      consecutive_failures: 3,
    };

    const result = rowToScheduledTask(row);
    expect(result.status).toBe("error");
    expect(result.consecutiveFailures).toBe(3);
  });
});

describe("rowToExecution", () => {
  const baseRow: ScheduledTaskExecutionRow = {
    id: "exec-1",
    task_id: "task-1",
    triggered_at: "2026-01-02T09:00:00Z",
    completed_at: null,
    status: "running",
    error_message: null,
    message_id: null,
    turn_id: null,
  };

  it("将 snake_case 行映射为 camelCase 实体", () => {
    const result = rowToExecution(baseRow);

    expect(result.id).toBe("exec-1");
    expect(result.taskId).toBe("task-1");
    expect(result.triggeredAt).toBe("2026-01-02T09:00:00Z");
    expect(result.completedAt).toBeNull();
    expect(result.status).toBe("running");
    expect(result.errorMessage).toBeNull();
    expect(result.messageId).toBeNull();
    expect(result.turnId).toBeNull();
  });

  it("完成的执行记录有 completedAt", () => {
    const row: ScheduledTaskExecutionRow = {
      ...baseRow,
      status: "completed",
      completed_at: "2026-01-02T09:00:05Z",
      message_id: "msg-1",
      turn_id: "turn-1",
    };

    const result = rowToExecution(row);
    expect(result.status).toBe("completed");
    expect(result.completedAt).toBe("2026-01-02T09:00:05Z");
    expect(result.messageId).toBe("msg-1");
    expect(result.turnId).toBe("turn-1");
  });

  it("失败的执行记录有 errorMessage", () => {
    const row: ScheduledTaskExecutionRow = {
      ...baseRow,
      status: "failed",
      completed_at: "2026-01-02T09:00:02Z",
      error_message: "超时",
    };

    const result = rowToExecution(row);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("超时");
  });

  it("status 为 null 时仍然正确映射", () => {
    const row: ScheduledTaskExecutionRow = {
      ...baseRow,
      status: null as unknown as string,
    };

    const result = rowToExecution(row);
    expect(result.status).toBeNull();
  });
});

describe("taskToRow", () => {
  it("将 camelCase 实体映射为 snake_case 行", () => {
    const task: ScheduledTask = {
      id: "task-1",
      conversationId: "conv-1",
      name: "每日摘要",
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
      body: "生成今日摘要",
      talkingStonePassedTo: ["otter-1", "otter-2"],
      senderId: "otter-1",
      status: "active",
      consecutiveFailures: 0,
      lastTriggeredAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    const result = taskToRow(task);

    expect(result.id).toBe("task-1");
    expect(result.conversation_id).toBe("conv-1");
    expect(result.name).toBe("每日摘要");
    expect(result.cron).toBe("0 9 * * *");
    expect(result.timezone).toBe("Asia/Shanghai");
    expect(result.body).toBe("生成今日摘要");
    expect(result.sender_id).toBe("otter-1");
    expect(result.status).toBe("active");
    expect(result.consecutive_failures).toBe(0);
    expect(result.last_triggered_at).toBeNull();
    expect(result.created_at).toBe("2026-01-01T00:00:00Z");
    expect(result.updated_at).toBe("2026-01-01T00:00:00Z");
  });

  it("talkingStonePassedTo 通过 JSON.stringify 序列化为字符串", () => {
    const task: ScheduledTask = {
      id: "task-1",
      conversationId: "conv-1",
      name: "测试",
      cron: "* * * * *",
      timezone: "UTC",
      body: "body",
      talkingStonePassedTo: ["otter-1"],
      senderId: "otter-1",
      status: "active",
      consecutiveFailures: 0,
      lastTriggeredAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    const result = taskToRow(task);
    expect(result.talking_stone_passed_to).toBe('["otter-1"]');
  });

  it("空数组序列化为 '[]' 字符串", () => {
    const task: ScheduledTask = {
      id: "task-1",
      conversationId: "conv-1",
      name: "测试",
      cron: "* * * * *",
      timezone: "UTC",
      body: "body",
      talkingStonePassedTo: [],
      senderId: "otter-1",
      status: "active",
      consecutiveFailures: 0,
      lastTriggeredAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    const result = taskToRow(task);
    expect(result.talking_stone_passed_to).toBe("[]");
  });
});

describe("rowToScheduledTask + taskToRow 往返一致性", () => {
  it("taskToRow → rowToScheduledTask 保留所有字段", () => {
    const original: ScheduledTask = {
      id: "task-roundtrip",
      conversationId: "conv-rt",
      name: "往返测试",
      cron: "30 14 * * 1-5",
      timezone: "America/New_York",
      body: "每日站会提醒",
      talkingStonePassedTo: ["otter-a", "otter-b"],
      senderId: "otter-a",
      status: "disabled",
      consecutiveFailures: 2,
      lastTriggeredAt: "2026-07-01T14:30:00Z",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-07-01T14:30:00Z",
    };

    const row = taskToRow(original);
    const restored = rowToScheduledTask(row);

    expect(restored).toEqual(original);
  });

  it("taskToRow → rowToScheduledTask 空 talkingStonePassedTo 保持一致", () => {
    const original: ScheduledTask = {
      id: "task-empty",
      conversationId: "conv-2",
      name: "空数组测试",
      cron: "0 0 * * *",
      timezone: "UTC",
      body: "body",
      talkingStonePassedTo: [],
      senderId: "sys",
      status: "active",
      consecutiveFailures: 0,
      lastTriggeredAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    const row = taskToRow(original);
    const restored = rowToScheduledTask(row);
    expect(restored).toEqual(original);
  });
});
