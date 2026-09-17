import type { ManageScheduledTask } from '@usecases/scheduled-task/manage-scheduled-task';
import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';

const HEALING_CRON = '0 9 * * *'; // 每天上午 9 点（F20260917swsh：三省吾身时间轴 8:30 健康检查 → 9:00 healing 分析）
const HEALING_TASK_NAME = 'self-healing-analysis';

/** #1004：验证断言回查任务——每日 11:00（错开 9:00 healing 分析 / 9:30 issue 处理，F20260917swsh 时间轴） */
const REGRESSION_VERIFY_CRON = '0 11 * * *';
const REGRESSION_VERIFY_TASK_NAME = 'regression-verify';

export async function ensureHealingScheduler(deps: {
  manageScheduledTask: ManageScheduledTask;
  scheduledTaskRepo: ScheduledTaskRepository;
  healingConversationId: string;
  bigOtterId: string;
}): Promise<void> {
  const tasks = await deps.scheduledTaskRepo.getByConversationId(deps.healingConversationId);

  // #1004：regression-verify seed 独立于 healing——必须在 healing 的 early return 之前，
  // 否则存量系统（healing 任务已 active）永远不会 seed regression-verify（检视发现 1）
  const existingRv = tasks.find(t => t.name === REGRESSION_VERIFY_TASK_NAME);
  if (!existingRv || existingRv.status !== 'active') {
    await deps.manageScheduledTask.create({
      conversationId: deps.healingConversationId,
      name: REGRESSION_VERIFY_TASK_NAME,
      cron: REGRESSION_VERIFY_CRON,
      timezone: 'Asia/Shanghai',
      body: '[regression-verify]',
      talkingStonePassedTo: [deps.bigOtterId],
      senderId: 'system',
    });
  }

  const existing = tasks.find(t => t.name === HEALING_TASK_NAME);
  if (existing && existing.status === 'active') return;

  await deps.manageScheduledTask.create({
    conversationId: deps.healingConversationId,
    name: HEALING_TASK_NAME,
    cron: HEALING_CRON,
    timezone: 'Asia/Shanghai',
    body: '[self-healing-analysis]',
    talkingStonePassedTo: [deps.bigOtterId],
    senderId: 'system',
  });
}
