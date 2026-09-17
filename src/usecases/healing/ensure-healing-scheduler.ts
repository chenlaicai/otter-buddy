import type { ManageScheduledTask } from '@usecases/scheduled-task/manage-scheduled-task';
import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';

const HEALING_CRON = '0 10 * * *'; // 每天上午 10 点
const HEALING_TASK_NAME = 'self-healing-analysis';

/** #1004：验证断言回查任务——每日 11:00（错开 9:00 health-check / 10:00 healing 分析） */
const REGRESSION_VERIFY_CRON = '0 11 * * *';
const REGRESSION_VERIFY_TASK_NAME = 'regression-verify';

export async function ensureHealingScheduler(deps: {
  manageScheduledTask: ManageScheduledTask;
  scheduledTaskRepo: ScheduledTaskRepository;
  healingConversationId: string;
  bigOtterId: string;
}): Promise<void> {
  const tasks = await deps.scheduledTaskRepo.getByConversationId(deps.healingConversationId);
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

  // #1004：同对话 seed 验证断言回查任务（复用 healing 对话，不新开）
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
}
