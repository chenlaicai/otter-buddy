/* eslint-disable max-lines -- 调度核心路径（触发/重试/healing 注入/指标/链看门狗）聚合于本文件，
   拆分需新建模块并移动多个私有方法，引入间接层而降低可读性；#516/#517 增加活跃看门狗与记账校验已尽量精简 */
import type { ConversationRepository } from '@usecases/conversation/conversation-repository';
import type { DispatchAttemptRepo } from '@entities/conversation/dispatch-attempt';
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
import type { SignalRouter } from '@usecases/conversation/signal-router';
import { DirectChainGatedError } from '@usecases/conversation/signal-router';
import type { FunctionRegistry } from '@usecases/paper-trading/function-registry';
import { DomainError, isSessionLockConflictError } from '@entities/errors';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** once 任务重试参数 */
const ONCE_MAX_RETRIES = 3;
const ONCE_RETRY_DELAY_MS = 65_000; // 65 秒（避开 claimTask 60s 窗口）

/** #640: 轮询间隔（30 秒）。quartz/celery beat 模式：定时扫描 active 任务，比对墙钟，迟到即补触发 */
const POLL_INTERVAL_MS = 30_000;
/** #775 执行级看门狗轮询：任务触发后按此间隔探测「台账在途尝试 + 产出活性」。
 *  #516 静默窗是「无产出才判死」的容忍窗；换轨后信号可能被闸门冻结（用户停机/限流熔断），
 *  静默窗判死会误杀「被闸门保留、等待恢复」的信号——判活优先看台账（in_progress 即活），
 *  闸门冻结由信号保留语义兜住（恢复后补扫点燃），不靠 scheduler 轮询硬等。 */
const LEDGER_WATCH_POLL_MS = 15_000;
/** #775 执行级看门狗硬上限：与链路径 MAX_CHAIN_TIMEOUT_MS 同值。 */
const LEDGER_WATCH_HARD_LIMIT_MS = 24 * 60 * 60 * 1000;

/** #642: 429/rate_limit 类错误的最大重试次数。超过此次数仍 429 → 判死（配额耗尽不会自愈，续期无意义） */
const MAX_429_RETRIES = 3;

/** #516: 链超时参数。语义从「一刀切墙钟」改为「静默容忍窗 + 硬上限」：
 *  静默窗内链无任何新消息 → 判死；有新消息（流式/终态均算）→ 链活跃，续期等待。
 *  背景：8-24/25/26《每日 issue 处理》被 15 分钟一刀切误杀——链实际跑到 18:47 正常收尾，
 *  底层工作完成但账面记 failed，3 次熔断后 status=error 静默停跑。
 *  默认静默窗 15 分钟（resolveChainSilenceMs 内联），任务级 timeoutMinutes 可覆盖。 */
/** 硬上限：无论链是否活跃，总时长超过即判死（防真死循环占住调度器） */
const MAX_CHAIN_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** 非链降级路径（未注入 dispatchChainEngine）：单次 invoke 5 分钟一刀切（旧语义保留） */
const SINGLE_INVOKE_TIMEOUT_MS = 5 * 60 * 1000;

/** Cron 解析接口（由 frameworks 层实现）
 *  #640: 支持 referenceTime 参数用于轮询模式下计算从某时间点起的下次触发时间 */
export interface CronParser {
  getNextTime(cron: string, timezone: string, referenceTime?: Date): Date;
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
  /** F20260902sgp2 S4b：派发台账（可选）——看门狗台账终态判活 */
  dispatchAttemptRepo?: DispatchAttemptRepo;
  /** #775 S4a 换轨：信号路由器（可选注入）。注入后定时任务触发 = 投信号 → 路由器点火
   *  （过闸门+台账记账）；未注入回退直连链（回滚面，与 sgpv 降级基线同语义）。 */
  signalRouter?: SignalRouter;
  metrics?: SchedulerMetricsPort;
  /** Why: 链外 invoke 路径不消费 yield 传递目标导致 yield 传递目标丢失（#332；
   *  F20260904schf 起链引擎改读行级 tsp，不再消费 turn 级 aggregatedTargets）。
   *  注入后 invokeAgentWithTimeout 走 DispatchChainEngine.executeChain 续跑发言链。 */
  dispatchChainEngine?: DispatchChainEngine;
  /** 时钟注入（F20260814qswp）：替代对 @frameworks/metrics nowMs 的直接依赖，测试可替换。
   *  默认保持原 nowMs 的单调钟语义（duration 计时不受 NTP 步进影响，对抗审视二轮修复——
   *  首版误用 Date.now 墙钟）；与调度延迟计算的 Date.now 是两条时间线，注入方须保持一致语义 */
  now?: () => number;
  /** PR4: 函数注册表，用于 function executor */
  functionRegistry?: FunctionRegistry;
}

export class SchedulerService {
  private timers = new Map<string, NodeJS.Timeout>();
  /** #640: 轮询定时器（唯一，全局扫描所有 active 任务） */
  private pollTimer: NodeJS.Timeout | undefined;
  /** #640: 任务下次预期触发时间缓存（内存，避免每次从 cron 重算） */
  private nextExpectedTrigger = new Map<string, Date>();
  private readonly taskRepo: ScheduledTaskRepository;
  private readonly convRepo: ConversationRepository;
  private readonly sendMessage: SendMessage;
  private readonly agentInvokePort: AgentTurnPort;
  private readonly cronParser: CronParser;
  private readonly logger: Logger;
  private readonly healingRepo?: HealingEventRepository;
  /** F20260902sgp2 S4b：派发台账——看门狗台账终态判活的数据源（可选，未注入回退消息判定） */
  private readonly dispatchAttemptRepo?: DispatchAttemptRepo;
  /** #775 S4a 换轨：信号路由器（可选）——注入后触发走投信号路径 */
  private signalRouter?: SignalRouter;
  /** #775 S4a：装配顺序注入点（路由器晚于 scheduler 诞生，构造期互指会循环依赖） */
  attachSignalRouter(router: SignalRouter): void {
    this.signalRouter = router;
  }
  private readonly metrics?: SchedulerMetricsPort;
  private readonly dispatchChainEngine?: DispatchChainEngine;
  private readonly now: () => number;
  private readonly manageSession?: ManageSession;
  private readonly functionRegistry?: FunctionRegistry;

  constructor(options: SchedulerServiceOptions) {
    this.taskRepo = options.taskRepo;
    this.convRepo = options.convRepo;
    this.sendMessage = options.sendMessage;
    this.agentInvokePort = options.agentInvokePort;
    this.cronParser = options.cronParser;
    this.logger = options.logger;
    this.healingRepo = options.healingRepo;
    this.dispatchAttemptRepo = options.dispatchAttemptRepo;
    this.signalRouter = options.signalRouter;
    this.metrics = options.metrics;
    this.dispatchChainEngine = options.dispatchChainEngine;
    this.now = options.now ?? (() => performance.now());
    this.manageSession = options.manageSession;
    this.functionRegistry = options.functionRegistry;

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
    // #775：启动对账——僵尸 running 执行翻篇（进程内无存活 running 跨越重启）。
    // 对账失败不阻塞启动（仅日志）：脏行只影响面板展示，不影响调度正确性。
    try {
      const stale = await this.taskRepo.failAllRunningExecutions();
      if (stale > 0) {
        this.logger.warn(`启动对账：${stale} 条僵尸 running 执行记录已翻篇为 failed`, { stale });
      }
    } catch (err) {
      this.logger.warn('启动对账失败（不阻塞启动）', { error: err instanceof Error ? err.message : String(err) });
    }
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
    // #640: 启动轮询定时器（quartz/celery beat 模式）
    this.startPolling();
  }

  /** 停止调度器（进程退出时调用） */
  stop(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    // #640: 停止轮询定时器
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    // #640: 清理轮询缓存
    this.nextExpectedTrigger.clear();
  }

  /** #640: 启动轮询定时器。每 POLL_INTERVAL_MS 扫描一次 active 任务，
   *  比对 last_triggered_at 与 cron 应触发点，越过即触发（迟到即补跑）。
   *  Why 不依赖 setTimeout：macOS 长延迟 setTimeout 会漂移（App Nap/冻结窗口），
   *  轮询模式用 setInterval + 墙钟比对，迟到即补，不丢触发。 */
  private startPolling(): void {
    if (this.pollTimer) return; // 防重复启动
    this.pollTimer = setInterval(async () => {
      try {
        await this.tick();
      } catch (error) {
        this.logger.error('Polling tick failed', error as Error);
      }
    }, POLL_INTERVAL_MS);
    // 立即执行一次 tick，捕获进程重启后的迟到任务（审视建议2: catch 防 unhandled rejection）
    void this.tick().catch(error => {
      this.logger.error('Initial polling tick failed', error as Error);
    });
  }

  /** #640: 轮询 tick——扫描所有 active 任务，比对预期触发时间与墙钟，
   *  越过即触发（迟到即补跑），记录 drift 值用于可观测性。 */
  private async tick(): Promise<void> {
    const tasks = await this.getAllActiveTasks();
    const now = Date.now();
    for (const task of tasks) {
      // once 任务走 setTimeout，轮询不干预
      if (task.scheduleType === 'once') continue;

      // 获取或计算下次预期触发时间
      let expected = this.nextExpectedTrigger.get(task.id);
      if (!expected) {
        // 首次 tick 或缓存丢失：从 last_triggered_at 计算
        const ref = task.lastTriggeredAt ? new Date(task.lastTriggeredAt) : undefined;
        expected = this.cronParser.getNextTime(task.cron, task.timezone, ref);
        this.nextExpectedTrigger.set(task.id, expected);
      }

      // 比对墙钟：预期触发时间已过 → 迟到，补触发
      // #640 防重复：lastTriggeredAt 在 POLL_INTERVAL_MS 内 → 已被 setTimeout 快路径触发，跳过
      if (expected.getTime() <= now && (!task.lastTriggeredAt || now - new Date(task.lastTriggeredAt).getTime() > POLL_INTERVAL_MS)) {
        const driftMs = now - expected.getTime();
        this.logger.info(`Polling: task ${task.id} overdue by ${driftMs}ms, triggering catch-up`, {
          taskId: task.id,
          expectedAt: expected.toISOString(),
          driftMs,
        });
        // 补触发（不阻塞后续任务扫描）
        void this.triggerTask(task).catch(error => {
          this.logger.error(`Polling: catch-up trigger failed for task ${task.id}`, error as Error);
        }).then(() => {
          // 触发后重新计算下次预期时间（无论成功失败都重算）
          try {
            const nextExpected = this.cronParser.getNextTime(task.cron, task.timezone);
            this.nextExpectedTrigger.set(task.id, nextExpected);
            // 同步刷新 setTimeout 快路径
            this.scheduleNext(task);
          } catch (e) {
            this.logger.error(`Polling: failed to reschedule task ${task.id}`, e as Error);
          }
        });
      } else {
        // 未到期：记录下次预期时间（可观测性）
        this.logger.debug(`Polling: task ${task.id} next expected at ${expected.toISOString()}`);
      }
    }
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
    // #640: 更新轮询缓存（下次预期触发时间）
    this.nextExpectedTrigger.set(task.id, nextTrigger);
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
          // #640: 触发后更新轮询缓存
          const newNextTrigger = this.cronParser.getNextTime(updatedTask.cron, updatedTask.timezone);
          this.nextExpectedTrigger.set(updatedTask.id, newNextTrigger);
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
      this.nextExpectedTrigger.delete(task.id); // 审视建议2: 清理缓存条目，防长期泄漏
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
        this.nextExpectedTrigger.delete(task.id); // 审视建议2: 清理缓存条目，防长期泄漏
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
  // eslint-disable-next-line max-statements, complexity, max-lines-per-function -- restartBeforeInvoke + #246 skipConsecutiveFailureTracking + PR4 function executor
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

      // PR4: function executor 分支——纯代码执行，无 LLM 会话
      if (task.executorType === 'function') {
        if (!this.functionRegistry) {
          throw new DomainError('Function registry not injected', 'validation');
        }
        if (!task.functionName) {
          throw new DomainError('functionName is required for executorType=function', 'validation');
        }

        executionStartMs = this.now();
        try {
          // 解析 body 中的参数（JSON 格式）
          let params: Record<string, unknown> = {};
          try {
            params = JSON.parse(task.body);
          } catch {
            this.logger.warn('Failed to parse task body as JSON, using empty params', { taskId: task.id });
          }

          // 执行函数
          const result = await this.functionRegistry.execute(task.functionName, params);

          // Why 不走 completeExecution：function executor 无 LLM 会话、不产生消息和 turn。
          // completeExecution 会写入 messageId=''（空串非 NULL，SQLite FK 不豁免——messages 表
          // 无 id=''，FOREIGN KEY constraint failed）并关联 getActiveTurn 的无关 turn。
          // 直接落 completed，messageId/turnId 留 NULL（FK 豁免，语义正确：无消息可关联）。
          await this.taskRepo.updateExecutionStatus(executionId, {
            status: 'completed',
            completedAt: new Date().toISOString(),
          });
          try {
            await this.taskRepo.resetConsecutiveFailures(task.id, now);
          } catch (resetErr) {
            this.logger.warn('resetConsecutiveFailures failed (non-fatal)', {
              taskId: task.id,
              error: resetErr instanceof Error ? resetErr.message : String(resetErr),
            });
          }
          status = 'completed';
          this.logger.info('Function executor completed', { taskId: task.id, functionName: task.functionName, result });
          return { executionId };
        } catch (error) {
          await this.handleTaskExecutionFailure(executionId, task.id, error, options?.skipConsecutiveFailureTracking);
          throw error;
        }
      }

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
        // #654: session 锁冲突 = 并发冲突（目标会话被活跃方持有，如人工调查/并行任务），
        // 非任务本身失败——execution 记 skipped、不 increment consecutiveFailures、不触发 3 连败熔断。
        // 判据：锁超时错误从 agent 调用链抛出（非链路径 rethrow，或锁链路径经 assertNoFailedMessages
        // 从 failed 消息反推，两者 message 均含锁超时前缀）。
        // Why 仍 rethrow：调用方语义各异（once 重试/手动触发者感知），锁冲突不算触发成功。
        if (isSessionLockConflictError(error)) {
          status = 'skipped';
          await this.handleExecutionSkipped(executionId, error);
          throw error;
        }
        // #775 S4a：调度闸门拦截（用户 halt / 限流熔断）——与锁冲突同类的「环境冲突
        // 非任务失败」：execution 记 skipped、不 increment consecutiveFailures、不触发熔断；
        // 信号已由路由器保留在台账，恢复窗口由补扫消化。Why 仍 rethrow：手动触发者需感知。
        if (error instanceof DirectChainGatedError) {
          status = 'skipped';
          await this.handleExecutionSkipped(executionId, error);
          throw error;
        }
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
    // #641: 检查是否存在未超时的 running execution，避免重复触发竞态
    // 同 task 存在 running execution → 拒绝 claim，记 skipped（非 failed）
    const runningExecutions = await this.taskRepo.getExecutions(task.id, { limit: 5 });
    const hasRunning = runningExecutions.some(exec =>
      exec.status === 'running' &&
      // 未超时判断：triggeredAt 在 MAX_CHAIN_TIMEOUT_MS 内（防僵尸 execution 无限阻塞）
      new Date(exec.triggeredAt).getTime() > Date.now() - MAX_CHAIN_TIMEOUT_MS
    );
    if (hasRunning) {
      throw new DomainError('Task already has a running execution, skipping this trigger', 'validation');
    }

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
    // #775 S4a 换轨（最优先分支）：注入路由器时投信号 → 路由器点火。
    // - 闸门生效：用户停机/限流熔断期间信号保留（skipped_halted/skipped_rate_limited），
    //   等用户显式恢复/窗口过后补扫点燃——不再绕过闸门（09-03 ihlt 同形态盲区封死）。
    // - 记账即销账：路由器点火即写 attempt（in_progress），与全系统唯一账本对齐；
    //   判据清零后本条 system 消息（带 tsp）本身就在路由器 pending 判据内，投信号后
    //   补扫也能兜底——双跑被幂等记账+阻尼挡住（F20260903damp）。
    // - 看门狗：#516 静默窗判死会误杀「被闸门冻结等待恢复」的信号，改为执行级
    //   台账判活轮询（in_progress 即活），闸门冻结期不判死（闸门拦截在直投处抛
    //   DirectChainGatedError 记 skipped，不会进入等待循环）。
    // 回滚面：摘除 platforms.ts 的 signalRouter 注入即回直连链（降级基线不变）。
    if (this.signalRouter) {
      if (anchorMessageId && task.talkingStonePassedTo.length > 0) {
        // #775 S4a：直投通道（原点独占点火权）。Why 不用 routePendingSignals：
        // ① 整会话扫描会把任务锚点外的历史 pending 也点爁（触发面失控）；
        // ② 闸门拦截时静默保留信号会让本方法空转轮询到硬上限（执行假死一天）——
        //    直投被闸门拒时抛 DirectChainGatedError，调用方记 skipped（非 failed），
        //    信号保留在台账，恢复后由补扫/下次触发消化。
        // 补扫兜底：若路由器点火前进程崩溃，锚点消息无账，重启补扫按台账判据点燃（双跑被幂等记账+阻尼挡住）。
        await this.signalRouter.routeDirectSignal(task.conversationId, anchorMessageId, task.talkingStonePassedTo[0]);
        await this.watchExecutionByLedger(task, anchorMessageId);
        return;
      }
      // 防御：无锚点/无目标（不应发生——createSystemMessage 必有 id，tsp 创建时必填）回退直连链路径
      this.logger.warn('scheduler 换轨路径缺少锚点或目标，回退直连链', { taskId: task.id, anchorMessageId: anchorMessageId ?? 'none' });
    }
    // Why: 有 dispatchChainEngine 时走链引擎续跑发言链（#332；F20260904schf 起
    // 链引擎读行级 tsp，不再消费 turn 级 aggregatedTargets），
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
        // F20260902sgp2 S1：定时任务链记账——trigger 为任务锚点消息（anchorMessageId
        // 由调用方注入；无锚时首 hop 不记账，仅 hop 2+ 按 yield 出处记，不阻断）
        triggerMessageId: anchorMessageId,
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
  /** #775 S4a：执行级台账判活看门狗（换轨路径专用）。
   *  与 watchChainWithActivity（静默窗判死）的本质区别：链路径握着 chainPromise 能等 settle；
   *  换轨后点火是路由器 fire-and-forget，无法握 promise——判活只能靠持久台账：
   *  - 锚点 attempt 全部到终态 → 执行收工（allAnchorAttemptsSettled，S4b 复用）
   *  - 有 in_progress 在途 → 活着，续期（#516 教训：静默 ≠ 死亡）
   *  - 无任何行（目标 busy 排队中 / 待点火）→ 保守等下一轮，硬上限兕底
   *  busy 排队语义（检视发现 1 处置说明）：routeDirectSignal 返回 queued_busy 时信号在
   *  busyQueue，无 attempt 行 → 本看门狗持续轮询。Why 正确：①排队会被目标 idle 后的
   *  debounce 重扫自动消化（分钟级），消化后 attempt 行出现，收敛到真实 completed；
   *  ②triggerTask 是 fire-and-forget，等待只挂起本任务的 Promise，不阻塞其他任务调度；
   *  ③若此时跳过等待记 completed = 任务未执行却记账完成（账面谎报，违 #517）。
   *  24h 硬上限即病态场景（目标持续 busy 一整天）的兕底。 */
  private async watchExecutionByLedger(task: ScheduledTask, anchorMessageId: string): Promise<void> {
    const deadline = this.now() + LEDGER_WATCH_HARD_LIMIT_MS;
    while (this.now() < deadline) {
      await new Promise(r => setTimeout(r, LEDGER_WATCH_POLL_MS));
      const settled = this.dispatchAttemptRepo?.allAnchorAttemptsSettled(anchorMessageId);
      if (settled === true) return;
      // false（在途）或 undefined（repo 未注入/查询失败）：保守续期
    }
    throw new Error(`Agent invocation timeout (ledger watch exceeded hard limit ${LEDGER_WATCH_HARD_LIMIT_MS / 3_600_000}h)`);
  }

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
    // #642: 429 重试计数器——连续 429 超过 MAX_429_RETRIES 次即判死
    let consecutive429Count = 0;
    while (Date.now() < deadline) {
      // #642: 检查链是否 settle（成功/失败）
      if (this.settleOutcome(chainSettled)) return;

      // 静默窗等待：链 settle 或静默窗到
      const winner = await this.waitForSilenceOrSettle(settled, silenceMs);
      if (winner === 'chain') {
        this.settleOutcome(chainSettled);
        return;
      }

      // 静默窗到：探测链活性（F20260902sgp2 S4b：台账终态优先，回退消息存在性）
      const alive = await this.isChainAliveByLedger(anchorMessageId)
        ?? await this.isChainStillActive(anchorMessageId);
      if (!alive) {
        if (this.settleOutcome(chainSettled)) return;
        throw new Error('Agent invocation timeout');
      }

      // #642: 检测链是否卡在 429 重试循环
      consecutive429Count = await this.check429Retry(
        anchorMessageId, task.id, consecutive429Count,
      );
    }
    throw new Error(`Agent invocation timeout (chain exceeded hard limit ${MAX_CHAIN_TIMEOUT_MS / 3_600_000}h)`);
  }

  /** #642: 等待静默窗或链 settle。提取为 helper 减少 watchChainWithActivity 语句数。 */
  private async waitForSilenceOrSettle(
    settled: Promise<void>,
    silenceMs: number,
  ): Promise<'chain' | 'silence'> {
    let timer: NodeJS.Timeout | undefined;
    const silence = new Promise<'silence'>(r => {
      timer = setTimeout(() => r('silence'), silenceMs);
    });
    const winner = await Promise.race([settled.then(() => 'chain' as const), silence]);
    if (timer) clearTimeout(timer);
    return winner;
  }

  /** #642: 检测链是否卡在 429 重试循环。提取为 helper 减少 watchChainWithActivity 语句数。 */
  private async check429Retry(
    anchorMessageId: string,
    taskId: string,
    consecutive429Count: number,
  ): Promise<number> {
    if (await this.isChainStuckOn429(anchorMessageId)) {
      const newCount = consecutive429Count + 1;
      this.logger.warn(`Chain watchdog: 429 retry detected (${newCount}/${MAX_429_RETRIES})`, {
        taskId,
        anchorMessageId,
      });
      if (newCount >= MAX_429_RETRIES) {
        throw new Error(`Agent invocation timeout: chain stuck on 429 rate limit (${newCount} retries, quota exhausted)`);
      }
      return newCount;
    }
    return 0; // 非 429 活跃，重置计数器
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
  /** F20260902sgp2 S4b：台账终态判活（看门狗）。
   *  @returns true=锚点 attempt 全终态（收工→alive=false 语义由调用方取反——注意本方法返回
   *           「链活跃与否」：true=有 in_progress 活跃；false=全终态收工；undefined=回退） */
  private async isChainAliveByLedger(anchorMessageId: string | undefined): Promise<boolean | undefined> {
    if (!anchorMessageId || !this.dispatchAttemptRepo) return undefined;
    try {
      const allSettled = await this.dispatchAttemptRepo.allAnchorAttemptsSettled(anchorMessageId);
      return !allSettled;
    } catch {
      return undefined;
    }
  }

  private async isChainStillActive(anchorMessageId: string): Promise<boolean> {
    try {
      const msgs = await this.convRepo.getMessagesAfter(anchorMessageId, 1);
      return Array.isArray(msgs) && msgs.length > 0;
    } catch {
      return false;
    }
  }

  /** #642: 检测链是否卡在 429 重试循环。
   *  429/rate_limit 类错误的特征：错误消息包含429/status_code/配额/limit 等关键词。
   *  链活跃但最近消息全是429重试 → 返回 true（应判死）；否则返回 false（真活跃）。
   *  使用 DESC 查询取最新消息——ASC 只能检测链开头 429，中途撞 429 永远漏检。 */
  private async isChainStuckOn429(anchorMessageId: string): Promise<boolean> {
    try {
      // 获取锚点后的最近几条消息（DESC，最新在前）
      const msgs = await this.convRepo.getLatestMessagesAfter(anchorMessageId, 3);
      if (!Array.isArray(msgs) || msgs.length === 0) return false;

      // 检查最近消息是否包含 429/rate_limit 特征
      const rateLimitPatterns = [
        /429/i,
        /rate.?limit/i,
        /quota/i,
        /配额.{0,10}耗尽/i,
        /too many requests/i,
      ];

      // 最近消息全是 429 相关 → 卡在 429 循环
      return msgs.every(msg => {
        const content = msg.segments.map(s => s.body).join('');
        return rateLimitPatterns.some(pattern => pattern.test(content));
      });
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

  /** messageId 为 null：function executor 无消息（PR4）；LLM executor 传 anchor 消息 id。
   * F20260901ppfk 检视处置：防御空串——未来新增 executor 类型若传 ''，归 null 不炸 FK */
  private async completeExecution(executionId: string, conversationId: string, messageId: string | null): Promise<void> {
    const activeTurn = await this.convRepo.getActiveTurn(conversationId);
    await this.taskRepo.updateExecutionStatus(executionId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      messageId: messageId || null,
      turnId: activeTurn?.id,
    });
  }

  /** #654: 锁冲突跳过记账——execution 记 skipped（非 failed），不 increment consecutiveFailures、
   *  不触发 3 连败熔断。errorMessage 留下锁冲突痕迹供面板/排查可见。 */
  private async handleExecutionSkipped(executionId: string, error: unknown): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    try {
      await this.taskRepo.updateExecutionStatus(executionId, {
        status: 'skipped',
        completedAt: new Date().toISOString(),
        errorMessage,
      });
    } catch (updateErr) {
      // 防御：记账失败不吞掉原始锁冲突错误（调用方语义更重要）
      this.logger.warn('updateExecutionStatus(skipped) failed for lock conflict (non-fatal)', {
        executionId,
        error: updateErr instanceof Error ? updateErr.message : String(updateErr),
      });
    }
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

## 处置权检查（前置，#600 口径协议 F20260831whfw）

处置任何 open 事件前，先检查其是否已被其他任务处置过口径：
- 事件关联了 daily-review issue（resolutionNotes 引用 issue 编号 / issue body 内含该事件证据）→ **不重复处置、不推翻**——首个消费它的任务（通常是 9:00 健康检查）拥有处置权；发现其处置存疑时，在对应 issue 评论说明，**不改事件状态**
- **原子性兑底**：若事件仍 open 但 \`created_at\` 时间早于今日 09:00 且无 resolutionNotes，先查今日 daily-review open issue 的 body 是否含该事件的 messageId（事件证据）→ 命中说明 9:00 任务已写入证据但 resolve 失败，在对应 issue 评论注明后**由本任务代为 resolve**（resolutionNotes 引用 issue 编号 + 代resolve说明）→ 无命中则按下方步骤正常处置
- 无关联 issue 的 open 事件 → 按下方步骤正常处置

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
