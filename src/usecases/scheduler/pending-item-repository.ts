import type {
  ExecutionStatus,
  ScheduledTaskPendingItem,
  ScheduledTaskPendingResolution,
} from '@entities/scheduled-task/scheduled-task';

export type ScheduledTaskPendingListItem = ScheduledTaskPendingItem & { taskName: string };

export interface ScheduledTaskPendingItemRepository {
  /** 部分唯一索引兜底同任务 pending 去重；返回是否真正入列。 */
  enqueue(item: ScheduledTaskPendingItem): Promise<boolean>;
  list(conversationId: string, role?: string): Promise<ScheduledTaskPendingListItem[]>;
  getById(id: string, conversationId: string): Promise<ScheduledTaskPendingListItem | null>;
  /** 同 cron 槽位的 execution 精确对账，不用周期长度启发式。 */
  hasExecutionInSlot(taskId: string, triggeredAt: string, statuses: ExecutionStatus[], excludeExecutionId?: string): Promise<boolean>;
  /** 真直发完成的 execution 带锚点 message_id；pending 自身的 completed(message_id=NULL) 不算已补执行。 */
  hasDirectCompletionInSlot(taskId: string, triggeredAt: string): Promise<boolean>;
  /** pending → consumed 的条件更新，重复 ack 返回 false。 */
  consume(input: {
    id: string;
    conversationId: string;
    role: string;
    resolution: ScheduledTaskPendingResolution;
    reason: string;
    consumedAt: string;
  }): Promise<boolean>;
}
