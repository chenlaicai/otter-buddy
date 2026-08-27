/* eslint-disable max-lines -- 调度核心路径（触发/重试/healing 注入/指标/链看门狗）聚合于本文件，
   拆分需新建模块并移动多个私有方法，引入间接层而降低可读性；#516/#517 增加活跃看门狗与记账校验已尽量精简 */
import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { SendMessage } from '@usecases/conversation/send-message';
import type { AgentTurnPort } from '@usecases/ports/agent-turn-port';
import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';
import type { ManageScheduledTask } from '@usecases/scheduled-task/manage-scheduled-task';
import type { ManageSession } from '@usecases/otter/manage-session';
import type { ScheduledTask } from '@entities/scheduled-task/scheduled-task';
import type { Message } from '@entities/conversation/message';
import type { Logger } from '@usecases/ports/logger';
import type { HealingEventRepository } from '@usecases/healing/healing-event-repository';
import type { SchedulerMetricsPort } from './scheduler-metrics-port';
import type { DispatchChainEngine } from '@usecases/conversation/dispatch-chain-engine';
import { DomainError } from '@entities/errors';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** once 任务重试参数 */
const ONCE_MAX_RETRIES = 3;
const ONCE_RETRY_DELAY_MS = 65_000; // 65 秒（避开 claimTask 60s 窗口）

/** #516: 链超时参数。语义从「一刀切墙钟」改为「静默容忍窗 + 硬上限」：
 *  静默窗内链无任何新消息 → 判死；有新消息（流式/终态均算）→ 链活跃，续期等待。
 *  背景：8-24/25/26《每日 issue 处理》被 15 分钟一刀切误杀——链实际跑到 18:47 正常收尾，
 *  底层工作完成但账面记 failed，3 次熔断后 status=error 静默停跑。
 *  默认静默窗 15 分钟（resolveChainSilenceMs 内联），任务级 timeoutMinutes 可覆盖。 */
/** 硬上限：无论链是否活跃，总时长超过即判死（防真死循环占住调度器） */
const MAX_CHAIN_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** 非链降级路径（未注入 dispatchChainEngine）：单次 invoke 5 分钟一刀切（旧语义保留） */
const SINGLE_INVOKE_TIMEOUT_MS = 5 * 60 * 1000;

/** Cron 解析接口（由 frameworks 层实现） */
export interface CronParser {
  getNextTime(cron: string, timezone: string): Date;
}

export interface SchedulerServiceOptions {
  taskRepo: ScheduledTaskRepository;
  convRepo: ConversationRepository;
  sendMessage: SendMessage;
  agentInvokePort: AgentTurnPort;
  cronParser: CronParser;
  logger: Logger;
  manageScheduledTask?: ManageScheduledTask;
  manageSession?: ManageSession;
  healingRepo?: HealingEventRepository;
  metrics?: SchedulerMetricsPort;
  /** Why: 链外 invoke 路径不消费 aggregatedTargets 导致 yield 传递目标丢失（#332）。
   *  注入后 invokeAgentWithTimeout 走 DispatchChainEngine.executeChain 续跑发言链。 */
  dispatchChainEngine?: DispatchChainEngine;
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
  private readonly agentInvokePort: AgentTurnPort;
  private readonly cronParser: CronParser;
  private readonly logger: Logger;
  private readonly healingRepo?: HealingEventRepository;
  private readonly metrics?: SchedulerMetricsPort;
  private readonly dispatchChainEngine?: DispatchChainEngine;
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
    this.dispatchChainEngine = options.dispatchChainEngine;
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
    // #247: 标记是否被截断到 24h
    const wasCapped = delay > maxDelay;

    const timer = setTimeout(async () => {
      if (wasCapped) {
        // #247: 24h 截断后只重新调度，不触发任务。
        // 原代码在此处调用 triggerTask 会导致月级/周级 cron 任务
        // 在中间每 24h 都被真实触发一次，浪费 LLM token 且打扰用户。
        const updatedTask = await this.taskRepo.getById(task.id);
        if (updatedTask?.status === 'active') {
          this.scheduleNext(updatedTask);
        }
      } else {
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
      // #516: once 任务重试耗尽同样落通知，消灭静默死亡
      await this.notifyTaskErrored(task.id, ONCE_MAX_RETRIES + 1, 'once task exhausted all retries');
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
      // #246: once 任务重试时跳过 handleExecutionFailure 的 consecutiveFailures 追踪，
      // 让 triggerOnceWithRetry 独立控制重试/error 语义。
      await this.triggerTask(task, { skipConsecutiveFailureTracking: true });
      // Why: 一次性任务重试成功后直接删除，不保留历史
      await this.taskRepo.delete(task.id);
    } catch (error) {
      this.logger.error(`Once task ${task.id} retry failed (${retriesLeft - 1} left)`, error as Error);
      await this.triggerOnceWithRetry(task, retriesLeft - 1);
    }
  }

  /** 触发单个任务。
   *  @param options.skipConsecutiveFailureTracking - #246: once 任务重试时跳过 consecutiveFailures 追踪，
   *    由 triggerOnceWithRetry 独立控制重试/error 语义，避免两层机制冲突。 */
  // eslint-disable-next-line max-statements, complexity -- restartBeforeInvoke + #246 skipConsecutiveFailureTracking 增加语句数和复杂度，重构会降低可读性
  private async triggerTask(task: ScheduledTask, options?: { skipConsecutiveFailureTracking?: boolean }): Promise<{ executionId: string }> {
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
        // Why 传入 anchor 消息 id：链看门狗用它探测链活性（#516），记账校验用它圈定执行窗口（#517）
        await this.invokeAgentWithTimeout(task, effectiveBody, message.id);
        // #517: invoke 正常 resolve 不代表 agent 成功——orchestrator 的 failTerminal/abortTerminal
        // 将消息置 failed 后正常返回 TurnResult，链引擎 allSettled 消化 rejection，
        // 锁超时/agent 异常无法经由 reject 传递到 scheduler 层。
        // 以最终消息状态为唯一事实源：anchor 后出现 status='failed' 的 otter 消息 → 抛错走 failure 记账，
        // 不再盲目记 completed。
        await this.assertNoFailedMessages(task.conversationId, message.id);
        await this.completeExecution(executionId, task.conversationId, message.id);
        // #251: resetConsecutiveFailures 在 completeExecution 之后执行，
        // 如果抛 DB 错不应覆写已 completed 的 execution record。
        // 吞掉错误，记录 warning 而不 throw。
        try {
          await this.taskRepo.resetConsecutiveFailures(task.id, now);
        } catch (resetErr) {
          this.logger.warn('resetConsecutiveFailures failed (non-fatal)', {
            taskId: task.id,
            error: resetErr instanceof Error ? resetErr.message : String(resetErr),
          });
        }
        status = 'completed';
        return { executionId };
      } catch (error) {
        await this.handleTaskExecutionFailure(executionId, task.id, error, options?.skipConsecutiveFailureTracking);
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
    const { message } = await this.sendMessage.send({
      conversationId: task.conversationId,
      senderType: 'system',
      senderId: task.senderId,
      body: body ?? task.body,
      talkingStonePassedTo: task.talkingStonePassedTo,
    });
    return message;
  }

  private async invokeAgentWithTimeout(task: ScheduledTask, body?: string, anchorMessageId?: string): Promise<void> {
    // Why: 有 dispatchChainEngine 时走链引擎消费 aggregatedTargets 续跑发言链（#332），
    // 否则降级为直接 invoke（兼容未注入的旧装配）。超时语义分路径：
    // - 链路径（#516）：静默容忍窗 + 硬上限。窗口内链无新消息才判死；有新消息即续期。
    //   任务级 timeoutMinutes 覆盖静默窗（默认 15 分钟），硬上限恒 24h。链 settle 即返回，
    //   不与链竞速——短任务不被拖到静默窗满。
    // - 非链路径：单次 invoke 5 分钟一刀切（旧语义保留，无链可观测）。
    // 链引擎自身有 maxChainDepth 安全限制，超时只是 scheduler 层的兜底防线。
    if (this.dispatchChainEngine) {
      const chainPromise = this.dispatchChainEngine.executeChain({
        conversationId: task.conversationId,
        userMessageContent: body ?? task.body,
        senderId: task.senderId,
        initialTargets: task.talkingStonePassedTo,
        invokeFn: async (params) => this.agentInvokePort.invokeConversation(params),
      });
      await this.watchChainWithActivity(task, anchorMessageId, chainPromise);
      return;
    }

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
          timer = setTimeout(() => reject(new Error('Agent invocation timeout')), SINGLE_INVOKE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** #516: 链活跃看门狗。与链 promise 竞速：链 settle（成功/失败）→ 透传返回/抛错；
   *  静默窗（silenceMs）到 → 探测锚点消息之后是否有新消息（任一状态都算链活跃）：
   *  - 有 → 链活跃，续期等待下一个静默窗口
   *  - 无（含探测失败）→ 判死，抛 Agent invocation timeout
   *  总时长恒受 MAX_CHAIN_TIMEOUT_MS 硬上限约束，防真死循环占住调度器。
   *  Why 含探测失败判死：链消息流不可读（DB 故障等）时链产出无从验证，继续等待只会永远占位。 */
  private async watchChainWithActivity(
    task: ScheduledTask,
    anchorMessageId: string | undefined,
    chainPromise: Promise<unknown>,
  ): Promise<void> {
    // 链 settle 观察者：settle 后 chainSettled 有值，race 立即胜出
    let chainSettled: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined;
    const settled = chainPromise.then(
      value => { chainSettled = { ok: true, value }; },
      error => { chainSettled = { ok: false, error }; },
    );

    if (!anchorMessageId) {
      // 防御：无锚点无法探测活性，退化为静默窗一刀切（不应发生——createSystemMessage 必有 id）
      await Promise.race([settled, new Promise(r => setTimeout(r, this.resolveChainSilenceMs(task)))]);
      if (this.settleOutcome(chainSettled)) return;
      throw new Error('Agent invocation timeout');
    }

    const silenceMs = this.resolveChainSilenceMs(task);
    const deadline = Date.now() + MAX_CHAIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      let timer: NodeJS.Timeout | undefined;
      const silence = new Promise<'silence'>(r => {
        timer = setTimeout(() => r('silence'), silenceMs);
      });
      const winner = await Promise.race([settled.then(() => 'chain' as const), silence]);
      if (timer) clearTimeout(timer);
      if (winner === 'chain') {
        // 链已 settle：透传（失败原样上抛，走 execution failure 记账）
        this.settleOutcome(chainSettled);
        return;
      }
      // 静默窗到：探测链活性
      const alive = await this.isChainStillActive(anchorMessageId);
      if (!alive) {
        // 对抗审视发现 1/3（审砚）：探测是 async 的，探测期间链可能恰好 settle
        // （含消息写入失败的 DB 异常路径——链正常结束但锚点后无可见消息）。
        // 此时透传链结果而非误抛 timeout。
        if (this.settleOutcome(chainSettled)) return;
        throw new Error('Agent invocation timeout');
      }
      // 链活跃，续期等待下一个静默窗口
    }
    throw new Error(`Agent invocation timeout (chain exceeded hard limit ${MAX_CHAIN_TIMEOUT_MS / 3_600_000}h)`);
  }

  /** 链 settle 结果透传：未 settle → false；settle 成功 → true（调用方正常返回）；
   *  settle 失败 → 原样上抛（走 execution failure 记账） */
  private settleOutcome(
    chainSettled: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined,
  ): boolean {
    if (!chainSettled) return false;
    if (!chainSettled.ok) throw chainSettled.error;
    return true;
  }

  /** #516: 链活性探测——锚点之后有任意新消息（任何状态）即活跃。
   *  探测失败（DB 异常）视为死亡：链产出无从验证，继续等待只会永远占位。 */
  private async isChainStillActive(anchorMessageId: string): Promise<boolean> {
    try {
      const msgs = await this.convRepo.getMessagesAfter(anchorMessageId, 1);
      return Array.isArray(msgs) && msgs.length > 0;
    } catch {
      return false;
    }
  }

  /** #516: 任务级静默窗取值——timeoutMinutes 配置优先，缺省 15 分钟 */
  private resolveChainSilenceMs(task: ScheduledTask): number {
    return (task.timeoutMinutes ?? 15) * 60 * 1000;
  }

  /** #517: 执行窗口记账校验。anchor 消息之后存在 status='failed' 的 otter 消息时抛错，
   *  将「agent 真失败但 execution 记 completed」的记账错位纠正为 failed。
   *  Why 只看 otter 消息：failed 的发出者必为执行链上的獭；用户消息不存在 failed 生命周期。
   *  Why 局限于锚点之后：同一会话旧轮次的 failed 消息（已熔断/已人工处理）不应牵连本次执行。 */
  private async assertNoFailedMessages(conversationId: string, anchorMessageId: string): Promise<void> {
    // 防御：查询抛错/返回异常值不阻塞记账（校验失败视为通过，交给既有 failure 路径兜底）
    let after: Message[] = [];
    try {
      after = await this.fetchMessagesAfterPaged(anchorMessageId);
    } catch { /* best-effort */ }
    const failed = after.find(m => m.senderType === 'otter' && m.status === 'failed');
    if (failed) {
      const preview = failed.segments.map(s => s.body).join('').slice(0, 200);
      throw new Error(`Agent invocation failed: otter message ${failed.id} terminated as failed${preview ? ` (${preview})` : ''}`);
    }
  }

  /** #517: 分页拉取锚点后全部消息。对抗审视发现 2（审砚）：单页 100 条上限
   *  会漏检深层失败（消息量 >100 且 failed 在 100 条之后时误记 completed）。
   *  getMessagesAfter 按 sequence_num 升序返回，以最后一条消息 id 为游标推进直到取空。 */
  private async fetchMessagesAfterPaged(anchorMessageId: string): Promise<Message[]> {
    const out: Message[] = [];
    let cursorId = anchorMessageId;
    const pageSize = 100;
    // 防御性硬上限 100 页（1 万条）：链受 24h 硬上限约束，单窗口消息量远低于此，超限属异常现场
    for (let page = 0; page < 100; page++) {
      const res = await this.convRepo.getMessagesAfter(cursorId, pageSize);
      if (!Array.isArray(res) || res.length === 0) break;
      out.push(...res);
      const next = res[res.length - 1].id;
      if (next === cursorId) break; // 防御：游标未推进（异常数据），避免死循环
      cursorId = next;
    }
    return out;
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
      // #516: error 不再静默——置 error 的同时在任务所属对话注入系统消息 + 写 healing event，
      // 消灭「3 次熔断停跑、用户看板偶遇才发现」的静默死亡。通知失败不阻塞状态变更本身。
      await this.notifyTaskErrored(taskId, failures, errorMessage);
    }
  }

  /** #516: 任务进入 error 状态的通知（系统消息 + healing event，均 best-effort）。
   *  Why sendMessage.send 而非 sendSystem：sendSystem 不支持指定 conversationId 的 sender 参数组，
   *  而 scheduler 的 createSystemMessage 一直走 sendMessage.send（senderType='system'），保持一致。 */
  private async notifyTaskErrored(taskId: string, failures: number, errorMessage: string): Promise<void> {
    const task = await this.taskRepo.getById(taskId).catch(() => null);
    if (!task) {
      this.logger.warn('notifyTaskErrored: task not found, skipping notification', { taskId });
      return;
    }
    const now = new Date().toISOString();
    const body = `[定时任务错误] 「${task.name}」连续 ${failures} 次执行失败，已自动停跑（status=error）。最近错误：${errorMessage}。请检查任务配置或手动恢复（update status='active'）后重试。`;

    // 1) 系统消息注入任务所属对话
    try {
      await this.sendMessage.send({
        conversationId: task.conversationId,
        senderType: 'system',
        senderId: task.senderId,
        body,
        // 系统消息豁免发言石校验，但接口要求必填——传空数组占位（createSystemMessage 同款语义）
        talkingStonePassedTo: [],
      });
    } catch (err) {
      this.logger.warn('notifyTaskErrored: system message failed (non-fatal)', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2) healing event（errorType='performance'：调度健康问题，进入 self-healing 分析视野）
    if (this.healingRepo) {
      try {
        await this.healingRepo.create({
          id: crypto.randomUUID(),
          messageId: '',
          conversationId: task.conversationId,
          otterId: task.talkingStonePassedTo[0] ?? '',
          errorType: 'performance',
          severity: 'high',
          description: `定时任务「${task.name}」连续 ${failures} 次失败停跑（#516）`,
          suggestion: `检查任务执行日志与错误「${errorMessage}」，修复后手动恢复 active`,
          context: { taskId, executionError: errorMessage, consecutiveFailures: failures },
          status: 'open',
          resolution: null,
          createdAt: now,
          resolvedAt: null,
        });
      } catch (err) {
        this.logger.warn('notifyTaskErrored: healing event write failed (non-fatal)', {
          taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** #246: 统一执行失败处理入口，根据 skipConsecutiveFailureTracking 选择路径。
   *  once 任务重试时只更新 execution record，不走 consecutiveFailures/status 标记，
   *  让 triggerOnceWithRetry 独立控制重试/error 语义。 */
  private async handleTaskExecutionFailure(
    executionId: string,
    taskId: string,
    error: unknown,
    skipConsecutiveFailureTracking?: boolean,
  ): Promise<void> {
    if (skipConsecutiveFailureTracking) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      try {
        await this.taskRepo.updateExecutionStatus(executionId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          errorMessage,
        });
      } catch (updateErr) {
        this.logger.warn('updateExecutionStatus failed in once-retry path (non-fatal)', {
          executionId,
          error: updateErr instanceof Error ? updateErr.message : String(updateErr),
        });
      }
    } else {
      await this.handleExecutionFailure(executionId, taskId, error);
    }
  }

  /** 获取所有 active 任务（直接查询，避免 N+1） */
  private async getAllActiveTasks(): Promise<ScheduledTask[]> {
    return this.taskRepo.getAllActive();
  }
}

const MAX_PROMPT_LENGTH = 8000;

/** self-healing-analysis 模板路径（issue #416：静态文案的 git 真相源，动态部分由 {{HEALING_DATA}} 占位符填充） */
export const HEALING_ANALYSIS_TEMPLATE_PATH = 'prompts/scheduled/self-healing-analysis.md';

/** 回退文案（模板缺失时用）。必须与模板静态部分保持一致——
 *  守卫测试 tests/usecases/scheduler/healing-analysis-template.test.ts 锁定同步，改任一处须同步另一处。 */
export const HEALING_FALLBACK_PROMPT = `## Self-Healing 定期分析任务

{{HEALING_DATA}}

请执行以下步骤：
1. 分析上述问题的根因，识别是否有重复/聚类模式
2. 对于你有能力直接修复的（术语、记忆类），提出具体建议
3. 对于需要修改 prompt 或代码的，生成清晰的修复描述
4. 与搭档讨论，达成共识后记录决策`;

/** 读取模板文件，去掉 frontmatter。文件缺失时返回 null（调用方回退到内置文案）。 */
function loadHealingTemplate(): string | null {
  const path = resolve(process.cwd(), HEALING_ANALYSIS_TEMPLATE_PATH);
  try {
    const content = readFileSync(path, 'utf8');
    const fm = content.match(/^---\n([\s\S]*?)\n---\n/);
    return fm ? content.slice(fm[0].length) : content;
  } catch {
    return null;
  }
}

/** 构建 healing 分析任务的动态 prompt。返回 null 表示无待处理事件。
 *  静态文案来自 prompts/scheduled/self-healing-analysis.md（issue #416 git 化），
 *  文件缺失时回退到内置文案保证可用性。 */
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

  let dataSection = `当前系统健康概况：
- 待处理: ${stats.open} 个
- 已解决: ${stats.resolved} 个
- 已忽略: ${stats.dismissed} 个
- 按类型分布: ${JSON.stringify(stats.byType)}
- 按严重程度分布: ${JSON.stringify(stats.bySeverity)}

以下是待处理的 healing events（共 ${openEvents.length} 条，按类型分组）：

`;

  for (const [type, events] of Object.entries(eventsByType)) {
    dataSection += `### ${type} (${events.length} 条)\n\n`;
    for (const e of events) {
      dataSection += `- [${e.severity}] ${e.description}\n`;
      if (e.suggestion) dataSection += `  建议: ${e.suggestion}\n`;
    }
    dataSection += '\n';
  }

  const template = loadHealingTemplate();
  let prompt: string;
  if (template?.includes('{{HEALING_DATA}}')) {
    prompt = template.replace('{{HEALING_DATA}}', dataSection);
  } else {
    // 回退：模板缺失或无占位符时用内置文案（与模板内容保持一致，守卫测试锁定同步）。
    //  Why 留痕：静默回退会让「模板丢了」无人知晓，git 化目标落空——warn 日志是最低成本的可观测性。
    // #416 审视发现 2：cwd 非项目根时模板会读不到，这条日志是定位线索。
    const path = resolve(process.cwd(), HEALING_ANALYSIS_TEMPLATE_PATH);
    // eslint-disable-next-line no-console -- logger 在类实例上，此处是模块级函数；console.warn 与脚本输出风格一致
    console.warn(`[healing-template] 模板缺失或无占位符（${path}），回退内置文案——若非预期请检查 cwd/部署路径`);
    prompt = HEALING_FALLBACK_PROMPT.replace('{{HEALING_DATA}}', dataSection);
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    prompt = prompt.slice(0, MAX_PROMPT_LENGTH) + '\n\n... (内容过长已截断，请使用 manage_healing_events 工具查询更多)';
  }

  return prompt;
}
