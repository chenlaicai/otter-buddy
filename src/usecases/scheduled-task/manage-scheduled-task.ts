import { DomainError } from '@entities/errors';
import type {
  ScheduledTask,
  ScheduledTaskExecution,
  ScheduledTaskStatus,
} from '@entities/scheduled-task/scheduled-task';
import {
  canTransitionTaskStatus,
  isValidCronExpression,
  isValidTimezone,
} from '@entities/scheduled-task/scheduled-task';
import type {
  ScheduledTaskRepository,
  ListExecutionsOptions,
} from './scheduled-task-repository';

export interface CreateScheduledTaskInput {
  conversationId: string;
  name: string;
  cron: string;
  timezone?: string;
  body: string;
  talkingStonePassedTo: string[];
  senderId?: string;
}

export interface UpdateScheduledTaskInput {
  name?: string;
  cron?: string;
  timezone?: string;
  body?: string;
  talkingStonePassedTo?: string[];
  status?: ScheduledTaskStatus;
}

export type TaskChangeCallback = (taskId: string, action: 'created' | 'updated' | 'deleted') => void;

export class ManageScheduledTask {
  private onChangeCallbacks: TaskChangeCallback[] = [];

  constructor(private readonly repo: ScheduledTaskRepository) {}

  /** 注册任务变更回调（用于通知 SchedulerService 清理 timer） */
  onChange(callback: TaskChangeCallback): void {
    this.onChangeCallbacks.push(callback);
  }

  private notifyChange(taskId: string, action: 'created' | 'updated' | 'deleted'): void {
    for (const cb of this.onChangeCallbacks) {
      cb(taskId, action);
    }
  }

  async create(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    // 校验 cron 表达式
    if (!isValidCronExpression(input.cron)) {
      throw new DomainError(`Invalid cron expression: ${input.cron}`, 'validation');
    }

    // 校验时区
    const timezone = input.timezone ?? 'Asia/Shanghai';
    if (!isValidTimezone(timezone)) {
      throw new DomainError(`Invalid timezone: ${timezone}`, 'validation');
    }

    // 校验 body 长度
    if (input.body.length > 10000) {
      throw new DomainError('body must be 10000 characters or less', 'validation');
    }

    // 校验 talkingStonePassedTo
    if (!input.talkingStonePassedTo || input.talkingStonePassedTo.length === 0) {
      throw new DomainError('talkingStonePassedTo must be non-empty', 'validation');
    }

    const now = new Date().toISOString();
    const task: ScheduledTask = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      name: input.name,
      cron: input.cron,
      timezone,
      body: input.body,
      talkingStonePassedTo: input.talkingStonePassedTo,
      senderId: input.senderId ?? input.talkingStonePassedTo[0],
      status: 'active',
      consecutiveFailures: 0,
      lastTriggeredAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.repo.create(task);
    this.notifyChange(task.id, 'created');
    return task;
  }

  async getById(id: string): Promise<ScheduledTask | null> {
    return this.repo.getById(id);
  }

  async getByConversationId(conversationId: string): Promise<ScheduledTask[]> {
    return this.repo.getByConversationId(conversationId);
  }

  async update(id: string, input: UpdateScheduledTaskInput): Promise<ScheduledTask> {
    const task = await this.repo.getById(id);
    if (!task) {
      throw new DomainError(`ScheduledTask not found: ${id}`, 'not_found');
    }

    this.validateUpdateInput(task.status, input);

    const now = new Date().toISOString();
    const updated: ScheduledTask = {
      ...task,
      name: input.name ?? task.name,
      cron: input.cron ?? task.cron,
      timezone: input.timezone ?? task.timezone,
      body: input.body ?? task.body,
      talkingStonePassedTo: input.talkingStonePassedTo ?? task.talkingStonePassedTo,
      status: input.status ?? task.status,
      updatedAt: now,
    };

    await this.repo.update(updated);
    this.notifyChange(updated.id, 'updated');
    return updated;
  }

  private validateUpdateInput(currentStatus: ScheduledTaskStatus, input: UpdateScheduledTaskInput): void {
    if (input.status && input.status !== currentStatus) {
      if (!canTransitionTaskStatus(currentStatus, input.status)) {
        throw new DomainError(
          `Invalid status transition: ${currentStatus} -> ${input.status}`,
          'validation',
        );
      }
    }

    if (input.cron && !isValidCronExpression(input.cron)) {
      throw new DomainError(`Invalid cron expression: ${input.cron}`, 'validation');
    }

    if (input.timezone && !isValidTimezone(input.timezone)) {
      throw new DomainError(`Invalid timezone: ${input.timezone}`, 'validation');
    }

    if (input.body && input.body.length > 10000) {
      throw new DomainError('body must be 10000 characters or less', 'validation');
    }
  }

  async delete(id: string): Promise<void> {
    const task = await this.repo.getById(id);
    if (!task) {
      throw new DomainError(`ScheduledTask not found: ${id}`, 'not_found');
    }
    await this.repo.delete(id);
    this.notifyChange(id, 'deleted');
  }

  async getExecutions(
    taskId: string,
    options?: ListExecutionsOptions,
  ): Promise<{ executions: ScheduledTaskExecution[]; total: number }> {
    const [executions, total] = await Promise.all([
      this.repo.getExecutions(taskId, options),
      this.repo.getExecutionCount(taskId),
    ]);
    return { executions, total };
  }
}
