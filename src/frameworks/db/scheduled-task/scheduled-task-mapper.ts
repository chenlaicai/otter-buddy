import type {
  ScheduledTask,
  ScheduledTaskExecution,
  ScheduledTaskStatus,
  ExecutionStatus,
  ScheduleType,
} from '@entities/scheduled-task/scheduled-task';

/** SQLite 行类型 */
export interface ScheduledTaskRow {
  id: string;
  conversation_id: string;
  name: string;
  schedule_type: string;
  cron: string;
  trigger_at: string | null;
  timezone: string;
  body: string;
  talking_stone_passed_to: string;  // JSON array
  sender_id: string;
  status: string;
  consecutive_failures: number;
  last_triggered_at: string | null;
  restart_before_invoke: number;
  executor_type: string;
  function_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledTaskExecutionRow {
  id: string;
  task_id: string;
  triggered_at: string;
  completed_at: string | null;
  status: string;
  error_message: string | null;
  message_id: string | null;
  turn_id: string | null;
}

/** DB Row -> Entity */
export function rowToScheduledTask(row: ScheduledTaskRow): ScheduledTask {
  let talkingStonePassedTo: string[] = [];
  try {
    talkingStonePassedTo = JSON.parse(row.talking_stone_passed_to);
    if (!Array.isArray(talkingStonePassedTo)) {
      talkingStonePassedTo = [];
    }
  } catch {
    // JSON 解析失败时使用空数组
  }

  return {
    id: row.id,
    conversationId: row.conversation_id,
    name: row.name,
    scheduleType: (row.schedule_type ?? 'cron') as ScheduleType,
    cron: row.cron,
    triggerAt: row.trigger_at,
    timezone: row.timezone,
    body: row.body,
    talkingStonePassedTo,
    senderId: row.sender_id,
    status: row.status as ScheduledTaskStatus,
    consecutiveFailures: row.consecutive_failures,
    lastTriggeredAt: row.last_triggered_at,
    restartBeforeInvoke: row.restart_before_invoke === 1,
    executorType: (row.executor_type ?? 'agent') as 'agent' | 'function',
    functionName: row.function_name ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToExecution(row: ScheduledTaskExecutionRow): ScheduledTaskExecution {
  return {
    id: row.id,
    taskId: row.task_id,
    triggeredAt: row.triggered_at,
    completedAt: row.completed_at,
    status: row.status as ExecutionStatus,
    errorMessage: row.error_message,
    messageId: row.message_id,
    turnId: row.turn_id,
  };
}

/** Entity -> DB params */
export function taskToRow(task: ScheduledTask): ScheduledTaskRow {
  return {
    id: task.id,
    conversation_id: task.conversationId,
    name: task.name,
    schedule_type: task.scheduleType,
    cron: task.cron,
    trigger_at: task.triggerAt,
    timezone: task.timezone,
    body: task.body,
    talking_stone_passed_to: JSON.stringify(task.talkingStonePassedTo),
    sender_id: task.senderId,
    status: task.status,
    consecutive_failures: task.consecutiveFailures,
    last_triggered_at: task.lastTriggeredAt,
    restart_before_invoke: task.restartBeforeInvoke ? 1 : 0,
    executor_type: task.executorType ?? 'agent',
    function_name: task.functionName ?? null,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}
