/**
 * 夜间审视 scheduled-task seed 单测。
 *
 * 钉住：幂等（已 active 不重建）、手动 disable 不复活（尊重搭档操作）、
 * function executor 形态（functionName/executorType/body 携带 conversationId）。
 */
import { describe, it, expect, vi } from "vitest";
import { ensureNightReviewTask, NIGHT_REVIEW_TASK_NAME } from "@usecases/scheduler/ensure-night-review-task";
import type { ManageScheduledTask } from "@usecases/scheduled-task/manage-scheduled-task";
import type { ScheduledTaskRepository } from "@usecases/scheduled-task/scheduled-task-repository";
import type { ScheduledTask } from "@entities/scheduled-task/scheduled-task";

function makeHarness(existing: Array<Partial<ScheduledTask>> = []) {
  const created: Array<Record<string, unknown>> = [];
  const tasks = existing.map((t, i) => ({
    id: `task-${i}`,
    conversationId: "conv-h",
    name: NIGHT_REVIEW_TASK_NAME,
    scheduleType: "cron",
    cron: "0 3 * * *",
    triggerAt: null,
    timezone: "Asia/Shanghai",
    body: "{}",
    description: null,
    executorRole: "night-reviewer",
    talkingStonePassedTo: [],
    senderId: "system",
    status: "active",
    consecutiveFailures: 0,
    lastTriggeredAt: null,
    restartBeforeInvoke: false,
    timeoutMinutes: null,
    executorType: "function",
    functionName: "night-review-orchestrator",
    createdAt: "2026-11-18T00:00:00.000Z",
    updatedAt: "2026-11-18T00:00:00.000Z",
    ...t,
  } as ScheduledTask));
  const taskRepo: Pick<ScheduledTaskRepository, "getByConversationId"> = {
    getByConversationId: vi.fn(async () => tasks),
  };
  const manage: Pick<ManageScheduledTask, "create"> = {
    create: vi.fn(async (input: unknown) => {
      created.push(input as Record<string, unknown>);
      return {} as ScheduledTask;
    }),
  };
  return { created, taskRepo, manage };
}

describe("ensureNightReviewTask（P2b2）", () => {
  it("无存量：seed function executor 任务（body 携带 conversationId）", async () => {
    const h = makeHarness();
    await ensureNightReviewTask({
      manageScheduledTask: h.manage as unknown as ManageScheduledTask,
      scheduledTaskRepo: h.taskRepo as unknown as ScheduledTaskRepository,
      conversationId: "conv-h",
    });
    expect(h.created).toHaveLength(1);
    const input = h.created[0];
    expect(input.executorType).toBe("function");
    expect(input.functionName).toBe("night-review-orchestrator");
    expect(input.cron).toBe("0 3 * * *");
    expect(input.timezone).toBe("Asia/Shanghai");
    expect(input.timeoutMinutes).toBe(240);
    expect(JSON.parse(String(input.body))).toEqual({ conversationId: "conv-h" });
  });

  it("存量 active：幂等不重建", async () => {
    const h = makeHarness([{ status: "active" }]);
    await ensureNightReviewTask({
      manageScheduledTask: h.manage as unknown as ManageScheduledTask,
      scheduledTaskRepo: h.taskRepo as unknown as ScheduledTaskRepository,
      conversationId: "conv-h",
    });
    expect(h.created).toHaveLength(0);
  });

  it("存量 disabled：不复活（手动停用是搭档操作，seed 尊重）", async () => {
    const h = makeHarness([{ status: "disabled" }]);
    await ensureNightReviewTask({
      manageScheduledTask: h.manage as unknown as ManageScheduledTask,
      scheduledTaskRepo: h.taskRepo as unknown as ScheduledTaskRepository,
      conversationId: "conv-h",
    });
    expect(h.created).toHaveLength(0);
  });
});
