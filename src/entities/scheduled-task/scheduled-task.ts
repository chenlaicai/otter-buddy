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
  // 每个字段只允许数字、*、/、-、, 和合法范围
  const patterns = [
    /^(\*|[0-5]?\d)(\/\d+)?$/,           // 分钟 0-59
    /^(\*|[01]?\d|2[0-3])(\/\d+)?$/,     // 小时 0-23
    /^(\*|[012]?\d|3[01])(\/\d+)?$/,     // 日 1-31
    /^(\*|[01]?\d|1[0-2])(\/\d+)?$/,     // 月 1-12
    /^(\*|[0-7])(\/\d+)?$/,              // 周 0-7
  ];
  return parts.every((part, i) => patterns[i].test(part));
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
