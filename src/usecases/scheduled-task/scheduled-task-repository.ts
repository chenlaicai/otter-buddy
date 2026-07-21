import type {
  ScheduledTask,
  ScheduledTaskExecution,
  ScheduledTaskStatus,
  ExecutionStatus,
} from '@entities/scheduled-task/scheduled-task';

export interface ListExecutionsOptions {
  limit?: number;
  offset?: number;
}

export interface ScheduledTaskRepository {
  // ScheduledTask CRUD
  create(task: ScheduledTask): Promise<void>;
  getById(id: string): Promise<ScheduledTask | null>;
  getByConversationId(conversationId: string): Promise<ScheduledTask[]>;
  update(task: ScheduledTask): Promise<void>;
  updateStatus(id: string, status: ScheduledTaskStatus, updatedAt: string): Promise<void>;
  delete(id: string): Promise<void>;

  // 连续失败管理
  incrementConsecutiveFailures(id: string, updatedAt: string): Promise<number>;
  resetConsecutiveFailures(id: string, updatedAt: string): Promise<void>;

  // 乐观锁抢占
  claimTask(id: string, lastTriggeredAt: string, updatedAt: string): Promise<boolean>;

  // 执行记录
  createExecution(execution: ScheduledTaskExecution): Promise<void>;
  updateExecutionStatus(
    id: string,
    status: ExecutionStatus,
    completedAt?: string,
    errorMessage?: string,
    messageId?: string,
    turnId?: string,
  ): Promise<void>;
  getExecutions(
    taskId: string,
    options?: ListExecutionsOptions,
  ): Promise<ScheduledTaskExecution[]>;
  getExecutionCount(taskId: string): Promise<number>;
}
