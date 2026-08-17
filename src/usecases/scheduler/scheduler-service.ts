import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { SendMessage } from '@usecases/conversation/send-message';
import type { AgentInvokePort } from '@usecases/ports/agent-invoke-port';
import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';
import type { ManageScheduledTask } from '@usecases/scheduled-task/manage-scheduled-task';
import type { ManageSession } from '@usecases/otter/manage-session';
import type { ScheduledTask } from '@entities/scheduled-task/scheduled-task';
import type { Logger } from '@usecases/ports/logger';
import type { HealingEventRepository } from '@usecases/healing/healing-event-repository';
import type { SchedulerMetricsPort } from './scheduler-metrics-port';
import { DomainError } from '@entities/errors';

/** once 任务重试参数 */
const ONCE_MAX_RETRIES = 3;
const ONCE_RETRY_DELAY_MS = 65_000; // 65 秒（避开 claimTask 60s 窗口）

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
  manageSession?: ManageSession;
  healingRepo?: HealingEventRepository;
  metrics?: SchedulerMetricsPort;
  /** 时钟注入（F20260814qswp）：替代对 @frameworks/metrics nowMs 的直接依赖，测试可替换。
   *  默认保持原 nowMs 的单调钟语义（duration 计时不受 NTP 步进影响，对抗审视二轮修复——
   *  首版误用 Date.now 墙钟）；与调度延迟计算的 Date.now 是两条时间线，注入方须保持一致语义 */
  now?: () => number;
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
  private readonly metrics?: SchedulerMetricsPort;
  private readonly now: () => number;
  private readonly manageSession?: ManageSession;

  constructor(options: SchedulerServiceOptions) {
    this.taskRepo = options.taskRepo;
    this.convRepo = options.convRepo;
    this.sendMessage = options.sendMessage;
    this.agentInvokePort = options.agentInvokePort;
    this.cronParser = options.cronParser;
    this.logger = options.logger;
    this.healingRepo = options.healingRepo;
    this.metrics = options.metrics;
    this.now = options.now ?? (() => performance.now());
    this.manageSession = options.manageSession;

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
            // 任务规模变化后刷新 gauge（status/type 变更都可能影响分布）
            await this.refreshActiveTaskGauge();
          } catch (error) {
            this.logger.error(`Failed to handle task change: ${taskId} ${action}`, error as Error);
          }
        });
      });
    }
  }

  /** 重新统计 active 任务并刷新 scheduler_active_tasks gauge。
   *  Why：start() 只设一次会让 gauge 长期失效；onChange 后刷新保证数据可信。 */
  private async refreshActiveTaskGauge(): Promise<void> {
    if (!this.metrics) return;
    const tasks = await this.getAllActiveTasks();
    const counts: Record<'cron' | 'once', number> = { cron: 0, once: 0 };
    for (const t of tasks) counts[t.scheduleType]++;
    this.metrics.setActiveTasks('cron', counts.cron);
    this.metrics.setActiveTasks('once', counts.once);
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
    if (this.metrics) {
      const counts: Record<string, number> = { cron: 0, once: 0 };
      for (const t of tasks) counts[t.scheduleType]++;
      (Object.keys(counts) as Array<'cron' | 'once'>).forEach(type =>
        this.metrics!.setActiveTasks(type, counts[type]),
      );
    }
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

    // Why: once 类型任务走独立分支，不经过 CronParser
    if (task.scheduleType === 'once') {
      this.scheduleOnce(task);
      return;
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

  /** once 任务调度：计算 delay，过期则删除，否则 setTimeout */
  private scheduleOnce(task: ScheduledTask): void {
    const triggerTime = new Date(task.triggerAt!).getTime();
    const delay = triggerTime - Date.now();

    if (delay <= 0) {
      // Why: 已过期的一次性任务直接删除，不保留历史
      // 使用 .catch() 避免 unhandled rejection（由 onChange 回调链调用）
      this.metrics?.recordExpired();
      this.taskRepo.delete(task.id)
        .then(() => {
          this.logger.info(`Once task ${task.id} expired, deleted`);
        })
        .catch(err => {
          this.logger.error(`Failed to delete expired once task ${task.id}`, err as Error);
        });
      return;
    }

    const timer = setTimeout(async () => {
      try {
        await this.triggerTask(task);
        // Why: 一次性任务触发成功后直接删除，不保留历史
        await this.taskRepo.delete(task.id);
      } catch (error) {
        this.logger.error(`Failed to trigger once task ${task.id}, starting retry`, error as Error);
        // 触发失败，走 once 专用重试
        await this.triggerOnceWithRetry(task, ONCE_MAX_RETRIES);
      }
    }, delay);

    this.timers.set(task.id, timer);
  }

  /** once 任务专用重试：失败后延迟重试，最多 maxRetries 次 */
  private async triggerOnceWithRetry(task: ScheduledTask, retriesLeft: number): Promise<void> {
    if (retriesLeft <= 0) {
      this.logger.error(`Once task ${task.id} exhausted all retries, marking as error`);
      await this.taskRepo.updateStatus(task.id, 'error', new Date().toISOString());
      return;
    }

    this.metrics?.recordRetry('once');
    await new Promise(r => setTimeout(r, ONCE_RETRY_DELAY_MS));

    // 二次检查：任务是否仍为 active（可能已被用户手动禁用）
    const current = await this.taskRepo.getById(task.id);
    if (!current || current.status !== 'active') {
      this.logger.info(`Once task ${task.id} no longer active (status=${current?.status}), aborting retry`);
      return;
    }

    try {
      await this.triggerTask(task);
      // Why: 一次性任务重试成功后直接删除，不保留历史
      await this.taskRepo.delete(task.id);
    } catch (error) {
      this.logger.error(`Once task ${task.id} retry failed (${retriesLeft - 1} left)`, error as Error);
      await this.triggerOnceWithRetry(task, retriesLeft - 1);
    }
  }

  /** 触发单个任务 */
  // eslint-disable-next-line max-statements -- restartBeforeInvoke 逻辑增加语句数，重构会降低可读性
  private async triggerTask(task: ScheduledTask): Promise<{ executionId: string }> {
    const now = new Date().toISOString();
    // Why 默认 'failed'：任何路径抛错（resolveEffectiveBody/createExecution DB 错等）
    //   未显式置 status 时，记 'failed' 比 'completed' 误导更小。
    //   claim/healing null 才显式置 'skipped'，完整走完才置 'completed'。
    let status: 'completed' | 'failed' | 'skipped' = 'failed';
    // execution 阶段开始时间：只测量 sendMessage/invoke/complete/reset 耗时，
    //   不含 claim/resolve/createExecution 前置操作（更准确反映 agent 执行耗时）。
    let executionStartMs = 0;

    try {
      await this.claimAndValidateTask(task, now).catch(err => {
        status = 'skipped';
        throw err;
      });

      const effectiveBody = await this.resolveEffectiveBody(task);
      if (effectiveBody === null) {
        status = 'skipped';
        return { executionId: '' };
      }

      const executionId = crypto.randomUUID();
      await this.createExecution(executionId, task.id, now);

      // F20260815rstrt: 触发前重启执行獭的 session（保持干净上下文）
      if (task.restartBeforeInvoke && task.talkingStonePassedTo.length > 0) {
        const executorOtterId = task.talkingStonePassedTo[0];
        if (!this.manageSession) {
          this.logger.warn('restartBeforeInvoke skipped: manageSession not injected', { taskId: task.id, otterId: executorOtterId });
        } else {
          try {
            await this.manageSession.restartSession(executorOtterId,
              `定时任务「${task.name}」触发前自动重启，保持干净上下文`);
            this.logger.info('Pre-trigger restart completed', { taskId: task.id, otterId: executorOtterId });
          } catch (err) {
            // Why 降级：重启失败不阻塞任务执行，记日志即可
            this.logger.error('Pre-trigger restart failed, continuing with task', err as Error, { taskId: task.id, otterId: executorOtterId });
          }
        }
      }

      executionStartMs = this.now();
      try {
        const message = await this.createSystemMessage(task, effectiveBody);
        await this.invokeAgentWithTimeout(task, effectiveBody);
        await this.completeExecution(executionId, task.conversationId, message.id);
        await this.taskRepo.resetConsecutiveFailures(task.id, now);
        status = 'completed';
        return { executionId };
      } catch (error) {
        await this.handleExecutionFailure(executionId, task.id, error);
        throw error;
      }
    } finally {
      this.metrics?.recordTrigger(task.scheduleType, status);
      // executionStartMs=0 表示前置阶段就抛错，不计入 histogram（无可观测的执行耗时）
      if (executionStartMs > 0) {
        this.metrics?.observeExecutionDuration(task.scheduleType, this.now() - executionStartMs);
      }
    }
  }

  /** 解析任务实际触发的 body：含 [self-healing-analysis] 占位符时动态替换为 healing 分析 prompt。
   *  返回 null 表示跳过本次触发（无待处理 healing events）。 */
  private async resolveEffectiveBody(task: ScheduledTask): Promise<string | null> {
    if (!this.healingRepo || !task.body.includes('[self-healing-analysis]')) {
      return task.body;
    }
    try {
      await this.healingRepo.autoStaleDismiss(30);
    } catch (err) {
      this.logger.warn('autoStaleDismiss failed, continuing with analysis', { error: err instanceof Error ? err.message : String(err) });
    }
    const body = await buildHealingAnalysisBody(this.healingRepo);
    if (body === null) {
      this.logger.info('Healing analysis skipped: no open events');
    }
    return body;
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
