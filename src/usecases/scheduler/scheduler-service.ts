import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { SendMessage } from '@usecases/conversation/send-message';
import type { AgentInvokePort } from '@usecases/ports/agent-invoke-port';
import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';
import type { ManageScheduledTask } from '@usecases/scheduled-task/manage-scheduled-task';
import type { ScheduledTask } from '@entities/scheduled-task/scheduled-task';
import type { Logger } from '@usecases/ports/logger';
import type { HealingEventRepository } from '@usecases/healing/healing-event-repository';
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
  logger: Logger;
  manageScheduledTask?: ManageScheduledTask;
  healingRepo?: HealingEventRepository;
}

export class SchedulerService {
  private timers = new Map<string, NodeJS.Timeout>();
  private readonly taskRepo: ScheduledTaskRepository;
  private readonly convRepo: ConversationRepository;
  private readonly sendMessage: SendMessage;
  private readonly agentInvokePort: AgentInvokePort;
  private readonly cronParser: CronParser;
  private readonly logger: Logger;
  private readonly healingRepo?: HealingEventRepository;

  constructor(options: SchedulerServiceOptions) {
    this.taskRepo = options.taskRepo;
    this.convRepo = options.convRepo;
    this.sendMessage = options.sendMessage;
    this.agentInvokePort = options.agentInvokePort;
    this.cronParser = options.cronParser;
    this.logger = options.logger;
    this.healingRepo = options.healingRepo;

    // 注册任务变更回调
    if (options.manageScheduledTask) {
      options.manageScheduledTask.onChange((taskId, action) => {
        // 使用 setImmediate 延迟执行异步操作
        setImmediate(async () => {
          try {
            if (action === 'deleted') {
              this.clearTaskTimer(taskId);
            } else if (action === 'updated') {
              this.clearTaskTimer(taskId);
              // 重新获取任务并调度
              const task = await this.taskRepo.getById(taskId);
              if (task?.status === 'active') {
                this.scheduleNext(task);
              }
            } else if (action === 'created') {
              // 获取新任务并调度
              const task = await this.taskRepo.getById(taskId);
              if (task?.status === 'active') {
                this.scheduleNext(task);
              }
            }
          } catch (error) {
            this.logger.error(`Failed to handle task change: ${taskId} ${action}`, error as Error);
          }
        });
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
        this.logger.error(`Failed to trigger task ${task.id}`, error as Error);
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

    // ── Healing: 动态替换 body ──
    let effectiveBody: string | null = task.body;
    if (this.healingRepo && task.body.includes('[self-healing-analysis]')) {
      try {
        await this.healingRepo.autoStaleDismiss(30);
      } catch (err) {
        this.logger.warn('autoStaleDismiss failed, continuing with analysis', { error: err instanceof Error ? err.message : String(err) });
      }
      effectiveBody = await buildHealingAnalysisBody(this.healingRepo);
      if (effectiveBody === null) {
        this.logger.info('Healing analysis skipped: no open events');
        return { executionId: '' };
      }
    }
    // ── end healing ──

    const executionId = crypto.randomUUID();
    await this.createExecution(executionId, task.id, now);

    try {
      const message = await this.createSystemMessage(task, effectiveBody!);
      await this.invokeAgentWithTimeout(task, effectiveBody!);
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

  private async createSystemMessage(task: ScheduledTask, body?: string) {
    return this.sendMessage.send({
      conversationId: task.conversationId,
      senderType: 'system',
      senderId: task.senderId,
      body: body ?? task.body,
      talkingStonePassedTo: task.talkingStonePassedTo,
    });
  }

  private async invokeAgentWithTimeout(task: ScheduledTask, body?: string): Promise<void> {
    const AGENT_TIMEOUT_MS = 5 * 60 * 1000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.agentInvokePort.invokeConversation({
          otterId: task.talkingStonePassedTo[0],
          conversationId: task.conversationId,
          userMessageContent: body ?? task.body,
          senderId: task.senderId,
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Agent invocation timeout')), AGENT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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

const MAX_PROMPT_LENGTH = 8000;

/** 构建 healing 分析任务的动态 prompt。返回 null 表示无待处理事件。 */
async function buildHealingAnalysisBody(healingRepo: HealingEventRepository): Promise<string | null> {
  const stats = await healingRepo.getStats();
  const openEvents = await healingRepo.findOpen(20);

  if (openEvents.length === 0) {
    return null;
  }

  const eventsByType = openEvents.reduce((acc, e) => {
    (acc[e.errorType] ??= []).push(e);
    return acc;
  }, {} as Record<string, typeof openEvents>);

  let prompt = `## Self-Healing 定期分析任务

当前系统健康概况：
- 待处理: ${stats.open} 个
- 已解决: ${stats.resolved} 个
- 已忽略: ${stats.dismissed} 个
- 按类型分布: ${JSON.stringify(stats.byType)}
- 按严重程度分布: ${JSON.stringify(stats.bySeverity)}

以下是待处理的 healing events（共 ${openEvents.length} 条，按类型分组）：

`;

  for (const [type, events] of Object.entries(eventsByType)) {
    prompt += `### ${type} (${events.length} 条)\n\n`;
    for (const e of events) {
      prompt += `- [${e.severity}] ${e.description}\n`;
      if (e.suggestion) prompt += `  建议: ${e.suggestion}\n`;
    }
    prompt += '\n';
  }

  prompt += `请执行以下步骤：
1. 分析上述问题的根因，识别是否有重复/聚类模式
2. 对于你有能力直接修复的（术语、记忆类），提出具体建议
3. 对于需要修改 prompt 或代码的，生成清晰的修复描述
4. 与搭档讨论，达成共识后记录决策`;

  if (prompt.length > MAX_PROMPT_LENGTH) {
    prompt = prompt.slice(0, MAX_PROMPT_LENGTH) + '\n\n... (内容过长已截断，请使用 manage_healing_events 工具查询更多)';
  }

  return prompt;
}
