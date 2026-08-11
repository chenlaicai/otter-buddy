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
  isValidTriggerAt,
} from '@entities/scheduled-task/scheduled-task';
import type {
  ScheduledTaskRepository,
  ListExecutionsOptions,
} from './scheduled-task-repository';

/** 校验 CreateScheduledTaskInput，返回错误消息或 null */
function validateCreateInput(input: CreateScheduledTaskInput): string | null {
  const scheduleType = input.scheduleType ?? 'cron';

  if (scheduleType === 'once') {
    if (!input.triggerAt) return 'triggerAt is required for scheduleType=once';
    if (!isValidTriggerAt(input.triggerAt)) return `Invalid triggerAt: ${input.triggerAt}`;
  } else {
    if (!input.cron) return 'cron is required for scheduleType=cron';
    if (!isValidCronExpression(input.cron)) return `Invalid cron expression: ${input.cron}`;
  }

  const timezone = input.timezone ?? 'Asia/Shanghai';
  if (!isValidTimezone(timezone)) return `Invalid timezone: ${timezone}`;
  if (input.body.length > 10000) return 'body must be 10000 characters or less';
  if (!input.talkingStonePassedTo || input.talkingStonePassedTo.length === 0) {
    return 'talkingStonePassedTo must be non-empty';
  }

  return null;
}

export interface CreateScheduledTaskInput {
  conversationId: string;
  name: string;
  /** 调度类型：cron=周期性，once=一次性。默认 'cron' */
  scheduleType?: 'cron' | 'once';
  /** scheduleType='cron' 时必填 */
  cron?: string;
  /** scheduleType='once' 时必填，ISO 8601 时间 */
  triggerAt?: string;
  timezone?: string;
  body: string;
  talkingStonePassedTo: string[];
  senderId?: string;
}

export interface UpdateScheduledTaskInput {
  name?: string;
  scheduleType?: 'cron' | 'once';
  cron?: string;
  triggerAt?: string | null;
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
    const validationError = validateCreateInput(input);
    if (validationError) {
      throw new DomainError(validationError, 'validation');
    }

    const scheduleType = input.scheduleType ?? 'cron';
    const now = new Date().toISOString();
    const task: ScheduledTask = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      name: input.name,
      scheduleType,
      cron: scheduleType === 'once' ? '' : input.cron!,
      triggerAt: scheduleType === 'once' ? input.triggerAt! : null,
      timezone: input.timezone ?? 'Asia/Shanghai',
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

    this.validateUpdateInput(task, input);

    const now = new Date().toISOString();
    const updated: ScheduledTask = {
      ...task,
      name: input.name ?? task.name,
      scheduleType: input.scheduleType ?? task.scheduleType,
      cron: input.cron ?? task.cron,
      triggerAt: input.triggerAt !== undefined ? input.triggerAt : task.triggerAt,
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

  private validateUpdateInput(task: ScheduledTask, input: UpdateScheduledTaskInput): void {
    this.validateUpdateFields(task, input);
    this.validateUpdateCrossFields(task, input);
  }

  /** 单字段格式校验 */
  private validateUpdateFields(task: ScheduledTask, input: UpdateScheduledTaskInput): void {
    if (input.status && input.status !== task.status) {
      if (!canTransitionTaskStatus(task.status, input.status)) {
        throw new DomainError(
          `Invalid status transition: ${task.status} -> ${input.status}`,
          'validation',
        );
      }
    }

    if (input.cron && !isValidCronExpression(input.cron)) {
      throw new DomainError(`Invalid cron expression: ${input.cron}`, 'validation');
    }

    if (input.triggerAt && !isValidTriggerAt(input.triggerAt)) {
      throw new DomainError(`Invalid triggerAt: ${input.triggerAt}`, 'validation');
    }

    if (input.timezone && !isValidTimezone(input.timezone)) {
      throw new DomainError(`Invalid timezone: ${input.timezone}`, 'validation');
    }

    if (input.body && input.body.length > 10000) {
      throw new DomainError('body must be 10000 characters or less', 'validation');
    }
  }

  /** scheduleType 与 cron/triggerAt 交叉校验 */
  private validateUpdateCrossFields(task: ScheduledTask, input: UpdateScheduledTaskInput): void {
    const effectiveScheduleType = input.scheduleType ?? task.scheduleType;

    if (effectiveScheduleType === 'once') {
      const effectiveTriggerAt = input.triggerAt !== undefined ? input.triggerAt : task.triggerAt;
      if (!effectiveTriggerAt) {
        throw new DomainError('triggerAt is required for scheduleType=once', 'validation');
      }
    }

    if (effectiveScheduleType === 'cron') {
      const effectiveCron = input.cron ?? task.cron;
      if (!effectiveCron) {
        throw new DomainError('cron is required for scheduleType=cron', 'validation');
      }
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
