import type { ScheduledTaskPendingListItem } from './pending-item-repository';

/** 只注入计数和最近任务名/时间；任务 body 由獭按需经 detail 拉取。 */
export function renderScheduledTaskAlerts(items: ScheduledTaskPendingListItem[], role: string): string | undefined {
  if (items.length === 0) return undefined;
  const latest = items[items.length - 1]!;
  const time = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(latest.triggeredAt));
  return `<system-reminder>\n## 定时任务待执行列表\n有 ${items.length} 条定时任务在你忙时触发并入列，目标角色：${role}（最近：${latest.taskName} ${time}）。\n手头事情完结后用 manage_scheduled_task_pending 查看并逐条处置（执行/跳过）。\n</system-reminder>`;
}
