/** 定时任务状态 */
export type ScheduledTaskStatus = 'active' | 'disabled' | 'error';

/** 调度类型：cron=周期性，once=一次性 */
export type ScheduleType = 'cron' | 'once';

/** 执行记录状态 */
export type ExecutionStatus = 'running' | 'completed' | 'failed';

/** 执行器类型 */
export type ExecutorType = 'agent' | 'function';

/** 定时任务实体 */
export interface ScheduledTask {
  id: string;
  conversationId: string;
  name: string;
  /** 调度类型：cron=周期性，once=一次性 */
  scheduleType: ScheduleType;
  cron: string;
  /** 一次性触发的精确 ISO 时间（scheduleType=once 时必填） */
  triggerAt: string | null;
  timezone: string;
  body: string;
  talkingStonePassedTo: string[];
  senderId: string;
  status: ScheduledTaskStatus;
  consecutiveFailures: number;
  lastTriggeredAt: string | null;
  /** F20260815rstrt: 每次触发前是否重启执行獭的 session（默认 false） */
  restartBeforeInvoke: boolean;
  /** PR4: 执行器类型（agent=LLM 会话，function=纯代码） */
  executorType: ExecutorType;
  /** PR4: function executor 时注册的函数名 */
  functionName?: string;
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

/** Cron 表达式基本格式校验（5字段：分 时 日 月 周）
 *  实体层只做最基本的格式校验，语义校验由 CronParser 负责
 */
export function isValidCronExpression(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  // 基本格式校验：每个字段只允许数字、*、/、-、,
  const basicPattern = /^[\d\s*/\-,]+$/;
  return parts.every(part => basicPattern.test(part));
}

/** ISO 8601 时间格式校验（scheduleType=once 时使用）
 *  校验规则：必须是合法 Date 且包含 'T' 分隔符（区分日期和时间）
 */
export function isValidTriggerAt(value: string): boolean {
  const date = new Date(value);
  return !isNaN(date.getTime()) && value.includes('T');
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
