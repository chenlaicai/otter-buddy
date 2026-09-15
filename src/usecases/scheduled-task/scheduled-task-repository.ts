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
  /** #775：启动对账——进程内不可能有存活的 running 执行跨越重启，全部翻篇为 failed。
   *  @returns 翻篇行数（日志可见）。先例：markStaleInProgressFailed（台账死亡证明）同款语义。 */
  failAllRunningExecutions(): Promise<number>;
  updateExecutionStatus(
    id: string,
    updates: {
      status: ExecutionStatus;
      completedAt?: string;
      errorMessage?: string;
      messageId?: string | null;
      turnId?: string | null;
    },
  ): Promise<void>;
  getExecutions(
    taskId: string,
    options?: ListExecutionsOptions,
  ): Promise<ScheduledTaskExecution[]>;
  getExecutionCount(taskId: string): Promise<number>;
}
