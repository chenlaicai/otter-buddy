import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { SendMessage } from '@usecases/conversation/send-message';
import type { AgentInvoker } from '@interface-adapters/agent-runtime/agent-invoker';
import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';
import type { ScheduledTask } from '@entities/scheduled-task/scheduled-task';

/** Cron 解析接口（由 frameworks 层实现） */
export interface CronParser {
  getNextTime(cron: string, timezone: string): Date;
}

export class SchedulerService {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly taskRepo: ScheduledTaskRepository,
    private readonly convRepo: ConversationRepository,
    private readonly sendMessage: SendMessage,
    private readonly agentInvoker: AgentInvoker,
    private readonly cronParser: CronParser,
  ) {}

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
      throw new Error(`ScheduledTask not found: ${taskId}`);
    }
    if (task.status !== 'active') {
      throw new Error(`Cannot trigger task with status: ${task.status}`);
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

    // 1. 乐观锁抢占
    const claimed = await this.taskRepo.claimTask(task.id, now, now);
    if (!claimed) {
      throw new Error('Task already triggered recently');
    }

    // 2. 检查对话状态
    const conversation = await this.convRepo.getById(task.conversationId);
    if (!conversation || conversation.status !== 'active') {
      await this.taskRepo.updateStatus(task.id, 'disabled', now);
      throw new Error('Conversation is not active');
    }

    // 3. 创建执行记录
    const executionId = crypto.randomUUID();
    await this.taskRepo.createExecution({
      id: executionId,
      taskId: task.id,
      triggeredAt: now,
      completedAt: null,
      status: 'running',
      errorMessage: null,
      messageId: null,
      turnId: null,
    });

    try {
      // 4. 创建 system 消息
      const message = await this.sendMessage.send({
        conversationId: task.conversationId,
        senderType: 'system',
        senderId: task.senderId,
        body: task.body,
        talkingStonePassedTo: task.talkingStonePassedTo,
      });

      // 5. 触发 Agent 响应（复用 invokeConversation）
      await this.agentInvoker.invokeConversation({
        otterId: task.talkingStonePassedTo[0],
        conversationId: task.conversationId,
        userMessageContent: task.body,
        senderId: task.senderId,
      });

      // 6. 更新执行记录为成功
      const activeTurn = await this.convRepo.getActiveTurn(task.conversationId);
      await this.taskRepo.updateExecutionStatus(
        executionId,
        'completed',
        new Date().toISOString(),
        undefined,
        message.id,
        activeTurn?.id,
      );

      // 7. 重置连续失败计数
      await this.taskRepo.resetConsecutiveFailures(task.id, new Date().toISOString());

      return { executionId };
    } catch (error) {
      // 8. 更新执行记录为失败
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.taskRepo.updateExecutionStatus(
        executionId,
        'failed',
        new Date().toISOString(),
        errorMessage,
      );

      // 9. 增加连续失败计数
      const failures = await this.taskRepo.incrementConsecutiveFailures(
        task.id,
        new Date().toISOString(),
      );
      if (failures >= 3) {
        await this.taskRepo.updateStatus(task.id, 'error', new Date().toISOString());
      }

      throw error;
    }
  }

  /** 获取所有 active 任务（private helper） */
  private async getAllActiveTasks(): Promise<ScheduledTask[]> {
    // 这里需要一个获取所有 active 任务的方法
    // 暂时通过遍历所有对话来实现，后续可以优化
    const allConversationIds = await this.convRepo.getAllIds();
    const tasks: ScheduledTask[] = [];
    for (const convId of allConversationIds) {
      const convTasks = await this.taskRepo.getByConversationId(convId);
      tasks.push(...convTasks.filter(t => t.status === 'active'));
    }
    return tasks;
  }
}
