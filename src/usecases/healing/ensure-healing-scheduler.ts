import type { ManageScheduledTask } from '@usecases/scheduled-task/manage-scheduled-task';
import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';

const HEALING_CRON = '0 10 * * *'; // 每天上午 10 点
const HEALING_TASK_NAME = 'self-healing-analysis';

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
}
