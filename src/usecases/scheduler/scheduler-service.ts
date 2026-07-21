import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { SendMessage } from '@usecases/conversation/send-message';
import type { AgentInvokePort } from './agent-invoke-port';
import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';
import type { ManageScheduledTask } from '@usecases/scheduled-task/manage-scheduled-task';
import type { ScheduledTask } from '@entities/scheduled-task/scheduled-task';
import { DomainError } from '@entities/errors';

/** Cron 解析接口（由 frameworks 层实现） */
export interface CronParser {
  getNextTime(cron: string, timezone: string): Date;
}

export interface SchedulerServiceOptions {
  taskRepo: ScheduledTaskRepository;
  convRepo: ConversationRepository;
  sendMessage: SendMessage;
  agentInvokePort: AgentInvokePort;
  cronParser: CronParser;
  manageScheduledTask?: ManageScheduledTask;
}

export class SchedulerService {
  private timers = new Map<string, NodeJS.Timeout>();
  private readonly taskRepo: ScheduledTaskRepository;
  private readonly convRepo: ConversationRepository;
  private readonly sendMessage: SendMessage;
  private readonly agentInvokePort: AgentInvokePort;
  private readonly cronParser: CronParser;

  constructor(options: SchedulerServiceOptions) {
    this.taskRepo = options.taskRepo;
    this.convRepo = options.convRepo;
    this.sendMessage = options.sendMessage;
    this.agentInvokePort = options.agentInvokePort;
    this.cronParser = options.cronParser;

    // 注册任务变更回调，清理已删除任务的 timer
    if (options.manageScheduledTask) {
      options.manageScheduledTask.onChange((taskId, action) => {
        if (action === 'deleted' || action === 'updated') {
          this.clearTaskTimer(taskId);
        }
      });
    }
  }

  /** 清理指定任务的 timer */
  private clearTaskTimer(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
  }

  /** 启动调度器 */
  async start(): Promise<void> {
    const tasks = await this.getAllActiveTasks();
    for (const task of tasks) {
      this.scheduleNext(task);
    }
  }

  /** 停止调度器（进程退出时调用） */
  stop(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /** 手动触发任务 */
  async trigger(taskId: string): Promise<{ executionId: string }> {
    const task = await this.taskRepo.getById(taskId);
    if (!task) {
      throw new DomainError(`ScheduledTask not found: ${taskId}`, 'not_found');
    }
    if (task.status !== 'active') {
      throw new DomainError(`Cannot trigger task with status: ${task.status}`, 'validation');
    }
    return this.triggerTask(task);
  }

  /** 为单个任务调度下次触发 */
  private scheduleNext(task: ScheduledTask): void {
    // 清除已有 timer
    const existing = this.timers.get(task.id);
    if (existing) {
      clearTimeout(existing);
    }

    const nextTrigger = this.cronParser.getNextTime(task.cron, task.timezone);
    const delay = nextTrigger.getTime() - Date.now();

    // 如果延迟超过 24 小时，使用 24 小时后重新计算
    const maxDelay = 24 * 60 * 60 * 1000;
    const actualDelay = Math.min(delay, maxDelay);

    const timer = setTimeout(async () => {
      try {
        await this.triggerTask(task);
      } catch (error) {
        console.error(`Failed to trigger task ${task.id}:`, error);
      }
      // 触发后重新调度下一次
      const updatedTask = await this.taskRepo.getById(task.id);
      if (updatedTask?.status === 'active') {
        this.scheduleNext(updatedTask);
      }
    }, actualDelay);

    this.timers.set(task.id, timer);
  }

  /** 触发单个任务 */
  private async triggerTask(task: ScheduledTask): Promise<{ executionId: string }> {
    const now = new Date().toISOString();

    await this.claimAndValidateTask(task, now);

    const executionId = crypto.randomUUID();
    await this.createExecution(executionId, task.id, now);

    try {
      const message = await this.createSystemMessage(task);
      await this.invokeAgentWithTimeout(task);
      await this.completeExecution(executionId, task.conversationId, message.id);
      await this.taskRepo.resetConsecutiveFailures(task.id, now);
      return { executionId };
    } catch (error) {
      await this.handleExecutionFailure(executionId, task.id, error);
      throw error;
    }
  }

  private async claimAndValidateTask(task: ScheduledTask, now: string): Promise<void> {
    const claimed = await this.taskRepo.claimTask(task.id, now, now);
    if (!claimed) {
      throw new DomainError('Task already triggered recently', 'validation');
    }

    const conversation = await this.convRepo.getById(task.conversationId);
    if (!conversation || conversation.status !== 'active') {
      await this.taskRepo.updateStatus(task.id, 'disabled', now);
      throw new DomainError('Conversation is not active', 'validation');
    }
  }

  private async createExecution(executionId: string, taskId: string, now: string): Promise<void> {
    await this.taskRepo.createExecution({
      id: executionId,
      taskId,
      triggeredAt: now,
      completedAt: null,
      status: 'running',
      errorMessage: null,
      messageId: null,
      turnId: null,
    });
  }

  private async createSystemMessage(task: ScheduledTask) {
    return this.sendMessage.send({
      conversationId: task.conversationId,
      senderType: 'system',
      senderId: task.senderId,
      body: task.body,
      talkingStonePassedTo: task.talkingStonePassedTo,
    });
  }

  private async invokeAgentWithTimeout(task: ScheduledTask): Promise<void> {
    const AGENT_TIMEOUT_MS = 5 * 60 * 1000;
    await Promise.race([
      this.agentInvokePort.invokeConversation({
        otterId: task.talkingStonePassedTo[0],
        conversationId: task.conversationId,
        userMessageContent: task.body,
        senderId: task.senderId,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Agent invocation timeout')), AGENT_TIMEOUT_MS)
      ),
    ]);
  }

  private async completeExecution(executionId: string, conversationId: string, messageId: string): Promise<void> {
    const activeTurn = await this.convRepo.getActiveTurn(conversationId);
    await this.taskRepo.updateExecutionStatus(executionId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      messageId,
      turnId: activeTurn?.id,
    });
  }

  private async handleExecutionFailure(executionId: string, taskId: string, error: unknown): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();

    await this.taskRepo.updateExecutionStatus(executionId, {
      status: 'failed',
      completedAt: now,
      errorMessage,
    });

    const failures = await this.taskRepo.incrementConsecutiveFailures(taskId, now);
    if (failures >= 3) {
      await this.taskRepo.updateStatus(taskId, 'error', now);
    }
  }

  /** 获取所有 active 任务（直接查询，避免 N+1） */
  private async getAllActiveTasks(): Promise<ScheduledTask[]> {
    return this.taskRepo.getAllActive();
  }
}
