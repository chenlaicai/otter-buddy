import type { ManageScheduledTask } from "@usecases/scheduled-task/manage-scheduled-task";
import type { AgentTool, ToolContext } from "@usecases/ports/agent-tools";
import { textResponse, errorResponse, type ToolResponse } from "@usecases/ports/agent-tools";

/** 校验参数，返回错误消息或 null */
function validateScheduledTaskParams(
  params: Record<string, unknown>,
): string | null {
  const name = params.name as string | undefined;
  const body = params.body as string | undefined;
  const scheduleType = (params.scheduleType as string) ?? "cron";

  if (!name || name.trim().length === 0) return "[错误] name 不能为空";
  if (!body || body.trim().length === 0) return "[错误] body 不能为空";
  if (scheduleType !== "cron" && scheduleType !== "once") {
    return `[错误] scheduleType 必须是 'cron' 或 'once'，收到：${scheduleType}`;
  }
  return null;
}

/** 创建 create_scheduled_task 工具 */
export function createCreateScheduledTaskTool(
  ctx: ToolContext,
  manageScheduledTask: ManageScheduledTask,
): AgentTool {
  return {
    name: "create_scheduled_task",
    description: "创建定时任务. When: 需要周期性或定时触发海獭执行（如每日摘要、定时提醒）. Not for: 即时通知 → 直接 speak. Output: 任务 ID + 调度信息确认. GOTCHA: scheduleType=cron 时 cron 必须是 5 字段；scheduleType=once 时 triggerAt 必须是 ISO 8601. BOUNDARY: 创建后立即生效，只能删不能暂停；大獭可创建，小獭不可.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "任务名称" },
        scheduleType: {
          type: "string",
          enum: ["cron", "once"],
          description: "调度类型：cron=周期性，once=一次性。默认 cron。",
        },
        cron: { type: "string", description: "cron 表达式（5字段），scheduleType=cron 时必填" },
        triggerAt: { type: "string", description: "一次性触发时间，ISO 8601，scheduleType=once 时必填" },
        timezone: { type: "string", description: "时区，默认 Asia/Shanghai" },
        body: { type: "string", description: "触发时发送给海獭的消息内容。写任务清单 + 判断委托（如「今日有 N 个 issue 待处理，请判断如何处理」）。不要写身份文本（如「你是小獭」），不要预设步骤——接收者自行判断处理方式。" },
        restartBeforeInvoke: { type: "boolean", description: "每次触发前是否重启执行獭的 session（默认 false）。适合需要干净上下文的定期任务（如健康检查）。" },
      },
      required: ["name", "body"],
    },
    execute: async (_id: string, params: Record<string, unknown>): Promise<ToolResponse> => {
      const validationError = validateScheduledTaskParams(params);
      if (validationError) return errorResponse(validationError);

      const scheduleType = (params.scheduleType as string) ?? "cron";
      try {
        const task = await manageScheduledTask.create({
          conversationId: ctx.conversationId,
          name: (params.name as string).trim(),
          scheduleType: scheduleType as 'cron' | 'once',
          cron: scheduleType === "cron" ? params.cron as string : undefined,
          triggerAt: scheduleType === "once" ? params.triggerAt as string : undefined,
          timezone: params.timezone as string | undefined,
          body: (params.body as string).trim(),
          restartBeforeInvoke: (params.restartBeforeInvoke as boolean) ?? false,
          talkingStonePassedTo: [ctx.otterId],
          senderId: ctx.otterId,
        });

        const scheduleDesc = scheduleType === "once"
          ? `一次性，触发时间: ${task.triggerAt}`
          : `周期性，cron: ${task.cron}`;
        return textResponse(`定时任务已创建：${task.id}（${task.name}，${scheduleDesc}，时区: ${task.timezone}）`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return errorResponse(`[错误] 创建定时任务失败：${msg}`);
      }
    },
  };
}
