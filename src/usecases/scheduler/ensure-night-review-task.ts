/**
 * 夜间审视 scheduled-task seed（幂等，挂 healing 初始化链尾）。
 *
 * 任务形态：executorType='function'、functionName='night-review-orchestrator'、
 * cron 每日 03:00 Asia/Shanghai（错开现有 7:30-11:00 时间轴——夜间审视字面意义放凌晨，
 * 且 LLM 长会话不与晨间任务抢链）；迟到补跑对账由 scheduler 对 active cron 任务
 * 自动生效（停机错过 → 重启后补触发，编排从旧水位继续），无需新机制。
 *
 * seed 门：挂在 gates.selfHealing 初始化链后（healing 对话存在 ⟹ seed）。selfHealing
 * 关闭的新部署无 healing 对话也无 belief 数据（主动记忆层生产数据只在本库），不 seed。
 */
import type { ManageScheduledTask } from "@usecases/scheduled-task/manage-scheduled-task";
import type { ScheduledTaskRepository } from "@usecases/scheduled-task/scheduled-task-repository";
import { NIGHT_REVIEW_TIMEOUT_MINUTES } from "@usecases/scheduler/night-review-orchestrator";

export const NIGHT_REVIEW_TASK_NAME = "夜间审视";
export const NIGHT_REVIEW_CRON = "0 3 * * *";

export async function ensureNightReviewTask(deps: {
  manageScheduledTask: ManageScheduledTask;
  scheduledTaskRepo: ScheduledTaskRepository;
  conversationId: string;
}): Promise<void> {
  const tasks = await deps.scheduledTaskRepo.getByConversationId(deps.conversationId);
  const existing = tasks.find((t) => t.name === NIGHT_REVIEW_TASK_NAME);
  // 存在即返回（含 disabled）：手动停用是搭档操作，seed 不复活也不重建同名双任务
  if (existing) return;

  await deps.manageScheduledTask.create({
    conversationId: deps.conversationId,
    name: NIGHT_REVIEW_TASK_NAME,
    cron: NIGHT_REVIEW_CRON,
    timezone: "Asia/Shanghai",
    // function executor 的 params 从 body 解析——编排需要知道对话归属（锚点 entry/fyi/matter）
    body: JSON.stringify({ conversationId: deps.conversationId }),
    description: "主动记忆层夜间审视：动态召唤夜审獭核对当日 recorded belief（全量核对+快照范围校验+幂等对账），变更集 fyi 挂 matter 否决锚",
    executorRole: "night-reviewer",
    talkingStonePassedTo: [],
    senderId: "system",
    executorType: "function",
    functionName: "night-review-orchestrator",
    timeoutMinutes: NIGHT_REVIEW_TIMEOUT_MINUTES,
  });
}
