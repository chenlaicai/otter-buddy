/** 定时任务状态 */
export type ScheduledTaskStatus = 'active' | 'disabled' | 'error';

/** 执行记录状态 */
export type ExecutionStatus = 'running' | 'completed' | 'failed';

/** 定时任务实体 */
export interface ScheduledTask {
  id: string;
  conversationId: string;
  name: string;
  cron: string;
  timezone: string;
  body: string;
  talkingStonePassedTo: string[];
  senderId: string;
  status: ScheduledTaskStatus;
  consecutiveFailures: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 定时任务执行记录实体 */
export interface ScheduledTaskExecution {
  id: string;
  taskId: string;
  triggeredAt: string;
  completedAt: string | null;
  status: ExecutionStatus;
  errorMessage: string | null;
  messageId: string | null;
  turnId: string | null;
}

/** 状态转换校验 */
export function canTransitionTaskStatus(
  from: ScheduledTaskStatus,
  to: ScheduledTaskStatus,
): boolean {
  // active -> disabled, error
  // disabled -> active
  // error -> active, disabled
  const validTransitions: Record<ScheduledTaskStatus, ScheduledTaskStatus[]> = {
    active: ['disabled', 'error'],
    disabled: ['active'],
    error: ['active', 'disabled'],
  };
  return validTransitions[from].includes(to);
}

/** Cron 表达式基本格式校验（5字段：分 时 日 月 周） */
export function isValidCronExpression(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  // 每个字段允许：数字、*、/、-、,
  // 使用 croner 库进行实际校验
  try {
    const Cron = require('croner');
    const job = Cron(cron);
    // 如果能创建 job 实例，说明表达式合法
    return job.nextRun() !== null;
  } catch {
    // croner 不可用时，使用基本格式校验
    const basicPattern = /^[\d\s*/\-,]+$/;
    return parts.every(part => basicPattern.test(part));
  }
}

/** IANA 时区格式校验 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
