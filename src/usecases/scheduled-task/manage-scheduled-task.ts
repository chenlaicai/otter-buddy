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
  isValidTimeoutMinutes,
  isValidTriggerAt,
} from '@entities/scheduled-task/scheduled-task';
import type {
  ScheduledTaskRepository,
  ListExecutionsOptions,
} from './scheduled-task-repository';

/** 校验调度类型相关字段（cron/triggerAt），返回错误消息或 null */
function validateScheduleFields(input: CreateScheduledTaskInput): string | null {
  const scheduleType = input.scheduleType ?? 'cron';

  if (scheduleType === 'once') {
    if (!input.triggerAt) return 'triggerAt is required for scheduleType=once';
    if (!isValidTriggerAt(input.triggerAt)) return `Invalid triggerAt: ${input.triggerAt}`;
  } else {
    if (!input.cron) return 'cron is required for scheduleType=cron';
    if (!isValidCronExpression(input.cron)) return `Invalid cron expression: ${input.cron}`;
  }
  return null;
}

/** #610: watchlist-only patch 语义——读旧 body JSON、只替换 watchlist 字段。
 *  返回 null 表示 body 不是合法 JSON 对象（旧格式/非 JSON body 不兼容此通道），由调用方抛 400，
 *  避免把非 JSON body 静默重写而丢内容。其他字段（prompt 等）原样保留，调用方无需携带 prompt 全文。 */
export function applyWatchlistPatch(body: string, watchlist: string[]): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return JSON.stringify({ ...(parsed as Record<string, unknown>), watchlist });
}

/** 校验 CreateScheduledTaskInput，返回错误消息或 null */
function validateCreateInput(input: CreateScheduledTaskInput): string | null {
  const scheduleError = validateScheduleFields(input);
  if (scheduleError) return scheduleError;

  const timezone = input.timezone ?? 'Asia/Shanghai';
  if (!isValidTimezone(timezone)) return `Invalid timezone: ${timezone}`;
  if (input.body.length > 10000) return 'body must be 10000 characters or less';
  if (!input.talkingStonePassedTo || input.talkingStonePassedTo.length === 0) {
    return 'talkingStonePassedTo must be non-empty';
  }

  const timeoutError = validateTimeoutMinutes(input.timeoutMinutes);
  if (timeoutError) return timeoutError;

  return null;
}

/** #516: timeoutMinutes 校验（create/update 共用）。null/undefined 合法（用默认）。 */
function validateTimeoutMinutes(value: number | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!isValidTimeoutMinutes(value)) {
    return `Invalid timeoutMinutes: ${value} (must be integer 1-1440)`;
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
  /** F20260815rstrt: 每次触发前是否重启执行獭的 session（默认 false） */
  restartBeforeInvoke?: boolean;
  /** #516: 任务级链超时配置（分钟）。null/缺省 = 调度器默认（15 分钟）。上限 1440（24h）。 */
  timeoutMinutes?: number | null;
  talkingStonePassedTo: string[];
  senderId?: string;
  /** PR4: 执行器类型（agent=LLM 会话，function=纯代码） */
  executorType?: 'agent' | 'function';
  /** PR4: function executor 时注册的函数名 */
  functionName?: string;
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
  /** F20260815rstrt: 每次触发前是否重启执行獭的 session */
  restartBeforeInvoke?: boolean;
  /** #516: 任务级链超时配置（分钟）。null = 回退调度器默认。 */
  timeoutMinutes?: number | null;
  /** PR4: 执行器类型（agent=LLM 会话，function=纯代码） */
  executorType?: 'agent' | 'function';
  /** PR4: function executor 时注册的函数名 */
  functionName?: string;
  /** #610: watchlist-only patch——服务端读旧 body JSON、只替换 watchlist 字段。
   *  调用方不再携带 prompt 全文（旧通道丢一字即损坏）。与 body 字段互斥。 */
  watchlist?: string[];
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
      restartBeforeInvoke: input.restartBeforeInvoke ?? false,
      timeoutMinutes: input.timeoutMinutes ?? null,
      executorType: input.executorType ?? 'agent',
      functionName: input.functionName,
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

  // eslint-disable-next-line complexity -- PR4: update method handles many fields
  async update(id: string, input: UpdateScheduledTaskInput): Promise<ScheduledTask> {
    const task = await this.repo.getById(id);
    if (!task) {
      throw new DomainError(`ScheduledTask not found: ${id}`, 'not_found');
    }

    this.validateUpdateInput(task, input);

    // #610: watchlist patch——与 body 显式互斥，双传说明调用方语义混乱，拒之。
    let effectiveBody = input.body ?? task.body;
    if (input.watchlist !== undefined) {
      if (input.body !== undefined) {
        throw new DomainError('watchlist and body are mutually exclusive in update', 'validation');
      }
      const patched = applyWatchlistPatch(task.body, input.watchlist);
      if (patched === null) {
        // Why 400：请求格式合法但旧 body 不支持 patch（非 JSON 对象），修复责任在调用方
        throw new DomainError(
          `Cannot patch watchlist: task body is not a JSON object (taskId=${id}). Use full body update instead.`,
          'validation',
        );
      }
      effectiveBody = patched;
      // Why：patched body 是新入库值，必须同样满足 10000 上限不变量（prompt 近上限+巨长 watchlist 可超）
      if (effectiveBody.length > 10000) {
        throw new DomainError('body must be 10000 characters or less', 'validation');
      }
    }

    const now = new Date().toISOString();
    const updated: ScheduledTask = {
      ...task,
      name: input.name ?? task.name,
      scheduleType: input.scheduleType ?? task.scheduleType,
      cron: input.cron ?? task.cron,
      triggerAt: input.triggerAt !== undefined ? input.triggerAt : task.triggerAt,
      timezone: input.timezone ?? task.timezone,
      body: effectiveBody,
      talkingStonePassedTo: input.talkingStonePassedTo ?? task.talkingStonePassedTo,
      status: input.status ?? task.status,
      restartBeforeInvoke: input.restartBeforeInvoke ?? task.restartBeforeInvoke,
      timeoutMinutes: input.timeoutMinutes !== undefined ? input.timeoutMinutes : task.timeoutMinutes,
      executorType: input.executorType ?? task.executorType,
      functionName: input.functionName ?? task.functionName,
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

    this.validateUpdateFieldFormats(input);

    if (input.body && input.body.length > 10000) {
      throw new DomainError('body must be 10000 characters or less', 'validation');
    }

    // #610: watchlist patch 格式校验——通用通道不做 A 股代码格式假设，只保证结构。
    // Why 空数组合法：操盘 prompt 对空自选池有明确行为（报告搭档），清空自选池是合法操作。
    if (input.watchlist !== undefined) {
      if (
        !Array.isArray(input.watchlist) ||
        input.watchlist.some(code => typeof code !== 'string' || code.length === 0)
      ) {
        throw new DomainError('watchlist must be an array of non-empty strings', 'validation');
      }
    }
  }

  /** 单字段格式校验（cron/triggerAt/timezone/timeoutMinutes） */
  private validateUpdateFieldFormats(input: UpdateScheduledTaskInput): void {
    if (input.cron && !isValidCronExpression(input.cron)) {
      throw new DomainError(`Invalid cron expression: ${input.cron}`, 'validation');
    }

    if (input.triggerAt && !isValidTriggerAt(input.triggerAt)) {
      throw new DomainError(`Invalid triggerAt: ${input.triggerAt}`, 'validation');
    }

    if (input.timezone && !isValidTimezone(input.timezone)) {
      throw new DomainError(`Invalid timezone: ${input.timezone}`, 'validation');
    }

    // #516: 任务级超时配置校验（null 表示清除配置，合法）
    const timeoutError = validateTimeoutMinutes(input.timeoutMinutes);
    if (timeoutError) {
      throw new DomainError(timeoutError, 'validation');
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
