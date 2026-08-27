import type {
  ScheduledTask,
  ScheduledTaskExecution,
} from '@entities/scheduled-task/scheduled-task';

/** 创建定时任务请求 */
export interface CreateScheduledTaskRequestDTO {
  name: string;
  scheduleType?: 'cron' | 'once';
  cron?: string;
  triggerAt?: string;
  timezone?: string;
  body: string;
  talkingStonePassedTo: string[];
  senderId?: string;
  /** F20260815rstrt: 每次触发前是否重启执行獭的 session */
  restartBeforeInvoke?: boolean;
  /** #516: 任务级链超时配置（分钟）。null/缺省 = 调度器默认（15 分钟） */
  timeoutMinutes?: number | null;
}

/** 更新定时任务请求 */
export interface UpdateScheduledTaskRequestDTO {
  name?: string;
  scheduleType?: 'cron' | 'once';
  cron?: string;
  triggerAt?: string | null;
  timezone?: string;
  body?: string;
  talkingStonePassedTo?: string[];
  status?: 'active' | 'disabled' | 'error';
  /** F20260815rstrt: 每次触发前是否重启执行獭的 session */
  restartBeforeInvoke?: boolean;
  /** #516: 任务级链超时配置（分钟）。null = 回退调度器默认 */
  timeoutMinutes?: number | null;
}

/** 定时任务响应 */
export interface ScheduledTaskDTO {
  id: string;
  conversationId: string;
  name: string;
  scheduleType: 'cron' | 'once';
  cron: string;
  triggerAt: string | null;
  timezone: string;
  body: string;
  talkingStonePassedTo: string[];
  senderId: string;
  status: string;
  consecutiveFailures: number;
  lastTriggeredAt: string | null;
  /** F20260815rstrt */
  restartBeforeInvoke: boolean;
  /** #516: 任务级链超时（分钟）。null = 调度器默认 */
  timeoutMinutes: number | null;
  nextTriggerAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 执行记录响应 */
export interface ScheduledTaskExecutionDTO {
  id: string;
  taskId: string;
  triggeredAt: string;
  completedAt: string | null;
  status: string;
  errorMessage: string | null;
  messageId: string | null;
  turnId: string | null;
}

/** 执行历史列表响应 */
export interface ListExecutionsResponseDTO {
  executions: ScheduledTaskExecutionDTO[];
  total: number;
  limit: number;
  offset: number;
}

/** Entity -> DTO 转换 */
export function toScheduledTaskDTO(task: ScheduledTask, nextTriggerAt?: string | null): ScheduledTaskDTO {
  return {
    id: task.id,
    conversationId: task.conversationId,
    name: task.name,
    scheduleType: task.scheduleType,
    cron: task.cron,
    triggerAt: task.triggerAt,
    timezone: task.timezone,
    body: task.body,
    talkingStonePassedTo: task.talkingStonePassedTo,
    senderId: task.senderId,
    status: task.status,
    consecutiveFailures: task.consecutiveFailures,
    lastTriggeredAt: task.lastTriggeredAt,
    restartBeforeInvoke: task.restartBeforeInvoke,
    timeoutMinutes: task.timeoutMinutes,
    nextTriggerAt: nextTriggerAt ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function toExecutionDTO(execution: ScheduledTaskExecution): ScheduledTaskExecutionDTO {
  return {
    id: execution.id,
    taskId: execution.taskId,
    triggeredAt: execution.triggeredAt,
    completedAt: execution.completedAt,
    status: execution.status,
    errorMessage: execution.errorMessage,
    messageId: execution.messageId,
    turnId: execution.turnId,
  };
}
