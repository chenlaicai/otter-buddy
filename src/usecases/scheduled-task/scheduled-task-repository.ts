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
  getAllActive(): Promise<ScheduledTask[]>;
  /** #784：全量任务（含 disabled）——prompt 启动对账用。disabled 任务 body 漂移同样要治，
   *  重新启用时该跑新 prompt（实证：每日 issue 处理 disabled 且 body 落后模板 2000+ 字符） */
  getAll(): Promise<ScheduledTask[]>;
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
  /** 全部 running execution（可按任务过滤；无 20 条窗口，忙判/对账不能漏旧行）。 */
  getRunningExecutions(taskId?: string): Promise<ScheduledTaskExecution[]>;
  /** 启动对账：无近期产出证据的 running 翻篇为 failed；有证据的 ID 由调用方保留。
   *  @returns 翻篇行数（日志可见）。 */
  failAllRunningExecutions(preserveExecutionIds?: string[]): Promise<number>;
  updateExecutionStatus(
    id: string,
    updates: {
      status: ExecutionStatus;
      completedAt?: string;
      errorMessage?: string;
      messageId?: string | null;
    },
  ): Promise<void>;
  getExecutions(
    taskId: string,
    options?: ListExecutionsOptions,
  ): Promise<ScheduledTaskExecution[]>;
  getExecutionCount(taskId: string): Promise<number>;
}
