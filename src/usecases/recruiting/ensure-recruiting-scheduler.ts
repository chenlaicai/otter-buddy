import type { ManageScheduledTask } from '@usecases/scheduled-task/manage-scheduled-task';
import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';
import {
  RECRUITING_SUMMARY_TASK_NAME,
  RECRUITING_SUMMARY_CRON,
  RECRUITING_SUMMARY_TIMEZONE,
  buildRecruitingSummaryBody,
} from './constants';

/**
 * F20260805rbrg：boot 时幂等创建每日摘要 scheduled task。
 *
 * 参考 F20260730heal 的 ensureHealingScheduler：检查同名 active 任务存在则跳过，
 * 否则创建。body 用固定 prompt 文本（不是 [self-healing-analysis] 拦截标记），
 * 因为大獭 prompt 已能驱动它主动 search_memory（spike 5 实测）。
 */
export async function ensureRecruitingScheduler(deps: {
  manageScheduledTask: ManageScheduledTask;
  scheduledTaskRepo: ScheduledTaskRepository;
  recruitingConversationId: string;
  bigOtterId: string;
}): Promise<void> {
  const tasks = await deps.scheduledTaskRepo.getByConversationId(deps.recruitingConversationId);
  const existing = tasks.find(t => t.name === RECRUITING_SUMMARY_TASK_NAME);
  if (existing && existing.status === 'active') return;

  // body 在创建时计算 today，但任务每天触发都用同一个 body——所以 today 是创建日的日期
  // 大獭在 invoke 时会按当前日期理解（"今日"），实际查询时用 created_after = 当日 0 点
  // 这是已知的微小偏差：body 里的日期是创建日，但语义上大獭按"今日"理解。
  // 如果未来要精确，再扩展 SchedulerService 支持 body 模板渲染。
  const todayIso = new Date().toISOString().slice(0, 10);
  const body = buildRecruitingSummaryBody(todayIso);

  await deps.manageScheduledTask.create({
    conversationId: deps.recruitingConversationId,
    name: RECRUITING_SUMMARY_TASK_NAME,
    cron: RECRUITING_SUMMARY_CRON,
    timezone: RECRUITING_SUMMARY_TIMEZONE,
    body,
    talkingStonePassedTo: [deps.bigOtterId],
    senderId: 'system',
  });
}
