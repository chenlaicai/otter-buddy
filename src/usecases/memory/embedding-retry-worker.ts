/**
 * F20260812mrcq Part 1 → F20261109epqst：embedding 后台队列消费者（原「重试 worker」）。
 *
 * F20261109epqst 后本 worker 是后台 embedding 的唯一消费者：
 * - store-memory 后台路径（文档 chunk）直接落库 embedding_tasks（不再预占 RAM 槽位）
 * - 实时路径失败/超时/槽位等待超时的任务也回流到本队列
 * - 本 worker 批量 claim → embedBatch 批量推理 → 逐条 storeEmbedding → markTaskDone
 *
 * 生命周期：PatrolWorker 每 1h 调 tickNow()；有积压时 fire-and-forget 后台 drain
 * 自续跑（无轮次/时间预算，直到清空；退避空窗由 retrigger 补上，检视处置 1）；
 * stop()/stopSync() 清理续跑定时器并等待收尾；dispose 不属在飞写入已关 DB。
 * 设计细节（守卫/退避/dead-letter/批处理）见各成员函数注释。
 */
import type { MemoryReader } from "./memory-reader";
import type { MemoryWriter } from "./memory-writer";
import type { MemoryQueue } from "./memory-queue";
import { EMBED_TASK_PRIORITY } from "./memory-queue";
import type { EmbeddingGateway } from "./embedding-gateway";
import { EmbedTimeoutError, EmbedBackpressureError, EmbedTransientError } from "./embedding-gateway";
import type { Logger } from "@usecases/ports/logger";

/** claimPendingTasks 返回的单条任务（MemoryQueue 接口为匿名类型，此处落名便于拆分函数签名）。
 *  F20261105embqg（对抗审视发现 2）：priority 从 claim 透传到执行端——
 *  retry 的 embed 也要按任务自身的优先级排槽位，否则 claim 层排序在执行层丢失 */
type EmbeddingTask = { entryId: string; content: string; attempts: number; priority: number };

export class EmbeddingRetryWorker {
  /** bge-m3 8192 tokens 上限的 ~75%（与 StoreMemory.EMBED_MAX_CHARS 一致） */
  private static readonly EMBED_MAX_CHARS = 6000;
  /**
   * 每次 tick 认领的任务上限。
   * F20261016ebrt：10 → 50——#948 闹钟瘦身把 tick 从 30s 调到 1h，却没调 BATCH_LIMIT，
   * 吞吐被打掉 120 倍（1200/时 → 10/时），1000 积压要 4 天才能吃完。
   * 50 条/tick × 1h = 50/时，配合 drain 循环可在一个 tick 内连吃多批。
   */
  private static readonly BATCH_LIMIT = 50;
  /**
   * F20261109epqst：批量消费的单批条数上限（组装 embedBatch 调用）。
   * 50 与 BATCH_LIMIT 对齐；service 层 token 预算闸门（8192）会再拆过大的批。
   */
  private static readonly EMBED_BATCH_SIZE = 50;
  /**
   * F20261109epqst 检视处置（严重发现 1）：MAX_DRAIN_ROUNDS/MAX_DRAIN_MS 已删除。
   * 原 20 轮/10min 预算是 tick 内联阻塞时代的约束（防 tick 挂死饿死 patrol），
   * drain 后台化后照抄成了「正常积压推回小时巡检」的脉冲边界——按实测
   * 1.13 条/s，600s 只够 ~678 条，生产 1000 条积压首轮即被截断，剩余空等
   * ~50min 到下个 patrol tick（验证盲区恰好覆盖：alpha 60/40 条、P3b 120 条
   * 均低于 678 边界）。根治：drain 自续跑直到队列清空（见 runBackgroundDrain
   * 终止条件），退避感知 retrigger 补上「全部在退避」的空窗。
   */
  /**
   * F20261109epqst：后台 drain 轮间冷却——让出事件循环给实时请求（live 消息
   * 的 fireAndForgetEmbed 在槽位层优先级更高，但冷却让 IO/HTTP 也有呼吸窗口）。
   */
  private static readonly DRAIN_COOLDOWN_MS = 100;
  /** retrigger 下界：防 DB 时钟秒级精度下轮询式自触发 */
  private static readonly RETRIGGER_MIN_MS = 2_000;
  /**
   * F20261105embqg S3（对抗审视发现 3）：空闲回填单 tick 上限——S3 闸门跳过的
   * 暗条目在队列清空后的恢复路径。有界增量，与启动暗扫的一次性全量区分。
   */
  private static readonly IDLE_BACKFILL_LIMIT = 200;
  /** retrigger 上界：退避封顶 1h，续跑延迟同量级封顶（更长的等待交给 patrol 周期） */
  private static readonly RETRIGGER_MAX_MS = 60 * 60 * 1000;
  /** queue 未实现 pendingTaskStats（旧 mock）时的 retrigger 兜底延迟 */
  private static readonly RETRIGGER_FALLBACK_MS = 60_000;
  /** 测试用 retrigger 延迟封顶（压缩等待窗口；null=不封顶） */
  private static testRetriggerCapMs: number | null = null;
  /**
   * F20261013ebps：连续全失败熔断——连续 N 轮 drain 全部失败（10/10 超时）
   * 说明 worker 已淹没（#1453），继续打只会加压。熔断后暂停消费，
   * 等下个 patrol 周期 tickNow 自动恢复（天然退避）。
   */
  private static readonly MAX_CONSECUTIVE_FULL_FAILURES = 3;
  private consecutiveFullFailures = 0;

  private timer: NodeJS.Timeout | null = null;
  private inflightTick: Promise<void> | null = null;
  /** F20261109epqst：后台 drain 循环（tickNow/retrigger 触发，fire-and-forget 运行） */
  private drainLoop: Promise<void> | null = null;
  /**
   * F20261109epqst 检视处置：退避感知续跑定时器（唯一槽位）。drain 因「全部
   * 任务在退避/lane 忙」退出且队列非空时，按最早可领取时间短延迟重启 drain——
   * 消灭「积压退避空窗等 patrol 1h」的脉冲。与 drainLoop 守卫配合保证单实例：
   * retrigger 回调经 ensureDrain 统一入口，已在跑则跳过。
   */
  private retriggerTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  /**
   * F20261109epqst：停机请求标志（stop/stopSync 置位）。与 stopped 生命周期标志
   * 分离：stopped 初始为 true（start() 前），若 drain 循环直接检查 stopped，
   * 未 start 的 worker（测试直接 tickNow / 生产首骋）会立即退出 drain。
   */
  private haltRequested = false;

  // eslint-disable-next-line max-params -- E 三分：拆为 Reader + Writer + Queue 三参数
  constructor(
    private readonly reader: MemoryReader,
    private readonly writer: MemoryWriter,
    private readonly queue: MemoryQueue,
    private readonly embeddingGateway: EmbeddingGateway,
    private readonly logger: Logger,
    private readonly intervalMs: number = 60 * 60 * 1000, // 2026-09-15 闹钟瘦身：30s→1h（暗化条目仅影响语义近邻召回，关键词召回不受影响，1h 延迟可接受）
    private readonly maxAttempts: number = 3,
  ) {}

  /** #949：启动语义变为「标记可工作」——定时器已由 PatrolWorker 统一持有（扫台账循环合并），
   *  本 worker 的周期性 tick 由 PatrolWorker 每 1h 调 tickNow() 驱动。
   *  start/stop 保留（生命周期幂等契约 + dispose 的 stopSync 调用方不动）。 */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.haltRequested = false;
  }

  /**
   * 停止 worker：clearInterval + 等待 in-flight tick/drain 完成（测试用）。
   * 测试中需要 await 保证 tick 完成后再断言 DB 状态。
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.haltRequested = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.retriggerTimer) {
      clearTimeout(this.retriggerTimer);
      this.retriggerTimer = null;
    }
    if (this.inflightTick) {
      await this.inflightTick;
    }
    if (this.drainLoop) {
      await this.drainLoop;
    }
  }

  /**
   * 同步停止：仅 clearInterval，不等 in-flight。
   * app.ts dispose 用此版本（process.exit 后 in-flight Promise 随进程消亡）。
   */
  stopSync(): void {
    this.stopped = true;
    this.haltRequested = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.retriggerTimer) {
      clearTimeout(this.retriggerTimer);
      this.retriggerTimer = null;
    }
  }

  /** F20261109epqst 检视处置：测试钩子——压缩 retrigger 等待窗口（判别性测试用） */
  static setTestRetriggerCapMs(cap: number | null): void {
    EmbeddingRetryWorker.testRetriggerCapMs = cap;
  }

  /**
   * 立即跑一轮 tick（当前唯一驱动：PatrolWorker 每 1h 巡检调用，见 app.ts）。
   * 启动首轮由 createAndStartRetryWorker 自跑，无事件接线。
   *
   * F20261020slvg：重入守卫——单 tick 可能跑几十分钟。
   *
   * F20261109epqst：tickNow 只做「触发」——守卫检查 + 熔断检查 + 空闲回填，
   * 有积压时启动后台 drain 循环（fire-and-forget，不阻塞 patrol duty 串行链——
   * 生产实锤：09:16 的 tick 挂死 1h+，把 PatrolWorker 其余 duty 全部饿死）。
   * drainLoop 重入守卫：已在跑则本轮 tickNow 直接受益（不并发）。
   */
  async tickNow(): Promise<void> {
    if (this.inflightTick) return;
    this.inflightTick = this.tick().catch(e =>
      this.logger.error(`EmbeddingRetryWorker tickNow failed: ${e}`),
    );
    try {
      await this.inflightTick;
    } finally {
      this.inflightTick = null;
    }
  }

  private async tick(): Promise<void> {
    // 审视 B3：双重守卫——worker 没 ready 或 vec 被运行时禁用都不消费
    if (!this.embeddingGateway.available) return;
    if (!this.reader.isVecEnabled()) return;

    // F20261013ebps：熔断——连续 N 轮全失败，暂停消费（worker 已淹，再打加压）
    if (this.consecutiveFullFailures >= EmbeddingRetryWorker.MAX_CONSECUTIVE_FULL_FAILURES) {
      if (this.consecutiveFullFailures % 10 === EmbeddingRetryWorker.MAX_CONSECUTIVE_FULL_FAILURES) {
        this.logger.warn(
          `EmbeddingRetryWorker circuit breaker open: ${this.consecutiveFullFailures} consecutive full-failure ticks, skipping`,
          { action: "embedding_retry_circuit_break" },
        );
      }
      this.consecutiveFullFailures++;
      return;
    }

    // F20261109epqst：有积压 → 启动/复用后台 drain（不阻塞 patrol duty）
    if (typeof this.queue.pendingTaskCount === "function") {
      const pending = await this.queue.pendingTaskCount();
      if (pending > 0) {
        this.ensureDrain();
        return;
      }
    } else {
      // 旧 mock 无 pendingTaskCount——直接 drain（兼容路径）
      this.ensureDrain();
      return;
    }

    // F20261105embqg S3（对抗审视发现 3）：空闲回填——高水位被跳过的暗条目
    // 不再只能等下次 sync/重启：队列空了才回填（有界）。详见 idleBackfillDarkEntries。
    await this.idleBackfillDarkEntries();
  }

  /**
   * F20261109epqst：drain 唯一启动入口（单实例守卫——tickNow/retrigger 并发触发
   * 时只跑一个循环）。retrigger 定时器先清（新循环自带退出时的重排期）。
   */
  private ensureDrain(): void {
    if (this.drainLoop) return; // 已在跑
    if (this.retriggerTimer) {
      clearTimeout(this.retriggerTimer);
      this.retriggerTimer = null;
    }
    this.drainLoop = this.runBackgroundDrain().catch(e =>
      this.logger.error(`EmbeddingRetryWorker background drain failed: ${e}`),
    ).finally(() => { this.drainLoop = null; });
  }

  /**
   * F20261109epqst 检视处置（严重发现 1）：后台 drain 自续跑——直到队列见底/
   * 全部在退避/lane 忙/熔断/停机才退出；无轮次与时间预算（原 MAX_DRAIN_ROUNDS/
   * MAX_DRAIN_MS 已删——那是 tick 内联阻塞时代的约束，照抄会把正常积压推回
   * 小时巡检脉冲化）。退出且队列非空时 scheduleRetrigger 按最早可领取时间续跑。
   * fire-and-forget 运行（tickNow 立即返回，patrol duty 不被饿死）；stop() await 收尾。
   */
  private async runBackgroundDrain(): Promise<void> {
    const totals = { claimed: 0, succeeded: 0, timedOut: 0, hardFailed: 0 };
    let stopReason: string;
    try {
      stopReason = await this.drainLoopBody(totals);
    } catch (err) {
      stopReason = "error";
      this.logger.error(`Embedding retry drain loop error: ${err}`);
    }
    await this.logDrainSummary(totals, stopReason);
    if (stopReason === "backoff" || stopReason === "lane-busy") {
      // 积压未清但本轮无可领——按退避窗口续跑（不等 patrol 1h）
      this.scheduleRetrigger(stopReason);
    }
  }

  /** drain 主循环体（从 runBackgroundDrain 拆出压复杂度）：返回停机原因 */
  private async drainLoopBody(
    totals: { claimed: number; succeeded: number; timedOut: number; hardFailed: number },
  ): Promise<string> {
    for (;;) {
      if (this.haltRequested) return "halted";
      const claimed = await this.queue.claimPendingTasks(EmbeddingRetryWorker.BATCH_LIMIT);
      if (claimed.length === 0) {
        this.consecutiveFullFailures = 0;
        // 队列见底 or 全部在退避——由 scheduleRetrigger 区分并按需续跑
        return "backoff";
      }
      totals.claimed += claimed.length;

      const stats = await this.processClaimedTasks(claimed);
      totals.succeeded += stats.successCount;
      totals.timedOut += stats.timeoutCount;
      totals.hardFailed += stats.hardFailureCount;

      const stop = this.evaluateDrainStop(stats);
      if (stop) return stop;
      // 轮间冷却：让出事件循环给实时请求/IO
      await new Promise<void>((resolve) => setTimeout(resolve, EmbeddingRetryWorker.DRAIN_COOLDOWN_MS));
    }
  }

  /**
   * 单轮停机判定（从 drainLoopBody 拆出）。
   * F20261020slvg 对抗审视洞 3：熔断只数硬失败轮（成功=0 且 hard>0）——纯超时轮
   * 是「lane 慢」的正常路径，计入熔断会让慢机器 3 轮后自我砖化。返回停机原因
   * 或 null（继续）。
   */
  private evaluateDrainStop(stats: { successCount: number; hardFailureCount: number; laneBusy: boolean }): string | null {
    if (this.haltRequested) return "halted";
    if (stats.laneBusy) return "lane-busy";
    if (stats.successCount === 0 && stats.hardFailureCount > 0) {
      this.consecutiveFullFailures++;
      if (this.consecutiveFullFailures >= EmbeddingRetryWorker.MAX_CONSECUTIVE_FULL_FAILURES) {
        this.logger.warn(
          `EmbeddingRetryWorker: ${this.consecutiveFullFailures} consecutive full-failure ticks, circuit breaker will open`,
          { action: "embedding_retry_circuit_break_warning" },
        );
        return "circuit-break";
      }
    } else {
      this.consecutiveFullFailures = 0;
    }
    return null;
  }

  /**
   * 检视处置（建议 2）：drain 汇总日志接生产可观测出口——pending 深度/最老任务
   * 年龄/优先级分布 + RAM 侧在飞/等待深度（service stats 可用时）。
   * 「最老年龄单调下降 = 旧任务持续出队」的验收抓手落到日志，无需手工 SQL。
   */
  private async logDrainSummary(
    totals: { claimed: number; succeeded: number; timedOut: number; hardFailed: number },
    stopReason: string,
  ): Promise<void> {
    if (totals.claimed === 0 && stopReason === "empty") return;
    const queueStats = (await this.safeQueueStats()) ?? { pending: -1, oldestAgeSeconds: null, byPriority: {} };
    // service stats：sync getter，可选实现（mock 无 stats 不炸日志）
    const svcStats = (this.embeddingGateway as { stats?: { inFlight: number; pendingWaiters: number } }).stats;
    this.logger.info("Embedding retry drain done", {
      action: "embedding_retry_drain_summary",
      claimed: totals.claimed,
      succeeded: totals.succeeded,
      timedOut: totals.timedOut,
      hardFailed: totals.hardFailed,
      stopReason,
      pending: queueStats.pending,
      oldestPendingAgeSeconds: queueStats.oldestAgeSeconds,
      pendingByPriority: queueStats.byPriority,
      ramInFlight: svcStats?.inFlight ?? null,
      ramPendingWaiters: svcStats?.pendingWaiters ?? null,
    });
  }

  /**
   * F20261109epqst 检视处置：退避感知续跑——队列非空但全部在退避（或 lane 忙）
   * 时，按最早可领取时间 +2s 护栏短延迟重启 drain。延迟封顶 1h（更长等待交
   * patrol 周期兜底）；测试可用 setTestRetriggerCapMs 压缩。
   */
  private scheduleRetrigger(reason: "backoff" | "lane-busy"): void {
    if (this.haltRequested) return;
    if (this.retriggerTimer) return; // 已有续跑排期
    if (typeof this.queue.pendingTaskStats === "function") {
      // pendingTaskStats 在 repo 实现是同步 SQL 包装的 async；统一按 promise 处理。
      // 回调内不检查 drainLoop（竞态根因：回调解到时若恰有另一 drain 在短暂收尾窗口，
      // 会误判「在跑」而放弃装定时器——而那个 drain 退出时又可能因 retriggerTimer
      // 曾被 ensureDrain 清过而不再补装，续跑链断裂）。唯一性由 armRetrigger 的
      // retriggerTimer 槽位保证；ensureDrain 启动新 drain 时主动清旧排期。
      this.queue.pendingTaskStats().then(s => {
        if (this.haltRequested) return;
        if (this.retriggerTimer) return;
        if (s.pending === 0) return; // 队列已清空，无需续跑
        this.armRetrigger(this.computeRetriggerDelayMs(s.earliestNextRetryAt ?? null, reason), reason);
      }).catch(() => {
        this.armRetrigger(EmbeddingRetryWorker.RETRIGGER_FALLBACK_MS, reason);
      });
      return;
    }
    this.armRetrigger(EmbeddingRetryWorker.RETRIGGER_FALLBACK_MS, reason);
  }

  /** 计算续跑延迟：最早可领取时间 + 护栏，夹在 [2s, 1h]（lane-busy 用固定 1s 冷却扩展） */
  private computeRetriggerDelayMs(earliestNextRetryAt: string | null, reason: "backoff" | "lane-busy"): number {
    let delay: number;
    if (reason === "lane-busy") {
      delay = 1_000; // lane 忙：短冷却即可（实时通道正在泄洪）
    } else if (earliestNextRetryAt) {
      const earliestMs = Date.parse(earliestNextRetryAt.replace(" ", "T") + "Z");
      delay = Number.isFinite(earliestMs) ? earliestMs - Date.now() + 1_000 : EmbeddingRetryWorker.RETRIGGER_FALLBACK_MS;
    } else {
      delay = EmbeddingRetryWorker.RETRIGGER_FALLBACK_MS;
    }
    const cap = EmbeddingRetryWorker.testRetriggerCapMs ?? EmbeddingRetryWorker.RETRIGGER_MAX_MS;
    return Math.min(Math.max(Math.ceil(delay), EmbeddingRetryWorker.RETRIGGER_MIN_MS), cap);
  }

  /** 装载续跑定时器（唯一槽位；不检查 drainLoop——收尾竞态窗口下漏装会断续跑链，
   * 定时器触发时 ensureDrain 自带单实例守卫） */
  private armRetrigger(delayMs: number, reason: "backoff" | "lane-busy"): void {
    if (this.haltRequested || this.retriggerTimer) return;
    this.retriggerTimer = setTimeout(() => {
      this.retriggerTimer = null;
      if (this.haltRequested) return;
      this.logger.debug(`Embedding retry drain retrigger (${reason})`, { action: "embedding_retry_retrigger", reason });
      this.ensureDrain();
    }, delayMs);
    this.retriggerTimer.unref?.();
  }

  /** 队列快照安全读取（pendingTaskStats 抛错时不拖垮 drain 收尾日志） */
  private async safeQueueStats(): Promise<{ pending: number; oldestAgeSeconds: number | null; byPriority: Record<number, number>; oldestNextRetryIn?: string | null } | null> {
    if (typeof this.queue.pendingTaskStats !== "function") return null;
    try {
      return await this.queue.pendingTaskStats();
    } catch {
      return null;
    }
  }


  /**
   * F20261109epqst：处理已 claim 的任务批次——批量 embedBatch 消费。
   *
   * 原 F20261020slvg 逐条 embedWithSalvage 是吞吐黑洞（检视獭发现 3：BATCH_LIMIT=50
   * 逐条仅排队开销就分钟级）；worker 原生支持批量（bge-m3 embed-batch 一次前向），
   * 本方法按 EMBED_BATCH_SIZE 组批串行调用 embedBatch（service 层 token 闸门
   * 会再拆过大的批）。
   *
   * 单批失败语义（对齐旧逐条路径的分类，整批适用）：
   * - EmbedBackpressureError / EmbedSlotTimeoutError（lane 忙/等待超时）→ 终止本轮，
   *   任务留 pending（claim 已 attempts+1，退避后下轮再领——不计 hard 失败）
   * - EmbedTimeoutError → 不计 attempts（salvage 可能已落库）；任务留 pending 重来
   * - EmbedTransientError（worker 重建/崩溃）→ 不计 attempts，任务留 pending
   * - 其他错误（真坏）→ 逐条 markTaskAttemptFailed（3 次 dead）
   * - 批成功后逐条 storeEmbedding；单条写库失败 → 任务留 pending 吃 claim 退避
   *   （不 enqueueRetry——ON CONFLICT 重置 next_retry_at=now 会在无界 drain 下活锁）
   */
  /** 幽灵任务分离（entry 已删，content 为空）——逐条记账转 dead，返回可执行集 */
  private async separateGhostTasks(
    claimed: EmbeddingTask[],
  ): Promise<{ actionable: EmbeddingTask[]; ghostFailures: number }> {
    const actionable: EmbeddingTask[] = [];
    let ghostFailures = 0;
    for (const task of claimed) {
      if (!task.content) {
        this.logger.warn(`EmbeddingRetryWorker: entry ${task.entryId} vanished, recording failed attempt`);
        await this.queue.markTaskAttemptFailed(task.entryId, new Error("entry deleted"), this.maxAttempts);
        ghostFailures++;
        continue;
      }
      actionable.push(task);
    }
    return { actionable, ghostFailures };
  }

  private async processClaimedTasks(
    claimed: EmbeddingTask[],
  ): Promise<{ successCount: number; timeoutCount: number; hardFailureCount: number; laneBusy: boolean }> {
    let successCount = 0;
    let timeoutCount = 0;
    let hardFailureCount = 0;

    // 过滤幽灵任务（entry 已删，content 为空）——逐条记账转 dead
    const { actionable, ghostFailures } = await this.separateGhostTasks(claimed);
    hardFailureCount += ghostFailures;

    const hasBatch = typeof this.embeddingGateway.embedBatch === "function";
    for (let offset = 0; offset < actionable.length; ) {
      if (this.haltRequested) break;
      const slice = actionable.slice(offset, offset + EmbeddingRetryWorker.EMBED_BATCH_SIZE);
      offset += slice.length;

      if (hasBatch && slice.length > 1) {
        const r = await this.processBatchSlice(slice);
        if (r.laneBusy) return { successCount, timeoutCount, hardFailureCount, laneBusy: true };
        successCount += r.successCount;
        timeoutCount += r.timeoutCount;
        hardFailureCount += r.hardFailureCount;
      } else {
        // 单条路径（无 embedBatch 或批内只剩 1 条）：保留旧逐条语义（含 salvage 双轨）
        const r = await this.processTasksSingly(slice);
        if (r.laneBusy) return { successCount, timeoutCount, hardFailureCount, laneBusy: true };
        successCount += r.successCount;
        timeoutCount += r.timeoutCount;
        hardFailureCount += r.hardFailureCount;
      }
    }
    return { successCount, timeoutCount, hardFailureCount, laneBusy: false };
  }

  /**
   * 批量消费一个 slice（embedBatch 路径）。错误分类语义见 processClaimedTasks 注释。
   */
  private async processBatchSlice(
    slice: EmbeddingTask[],
  ): Promise<{ successCount: number; timeoutCount: number; hardFailureCount: number; laneBusy: boolean }> {
    let successCount = 0;
    // 同批任务优先级一致才能正确排队（claim 按 priority ASC 顺序返回，
    // 同优先级连续——slice 边界处可能混档，取首条优先级即可：优先级只影响
    // 槽位排队次序，不改变正确性）
    const batchPriority = slice[0].priority;
    try {
      const texts = slice.map(t => this.truncateForStore(t.content));
      const embeddings = await this.embeddingGateway.embedBatch!(texts, {
        waitSlot: true,
        priority: batchPriority,
      });
      for (let i = 0; i < slice.length; i++) {
        try {
          await this.writer.storeEmbedding(slice[i].entryId, embeddings[i]);
          await this.queue.markTaskDone(slice[i].entryId);
          successCount++;
        } catch (err) {
          // F20261109epqst 检视处置追修（P5 CI 慢机暴露）：写库失败**不走 enqueueRetry**。
          // 任务行仍在（claim 不删行），claim 已按 attempts 推 next_retry_at 到退避未来
          // ——「回队」由退避自然实现。若 enqueueRetry 会把 next_retry_at 重置为 now，
          // drain 无界续跑下同轮立即重领、attempts 快速到 3 → 真实活锁成 dead-letter
          // （本地快机 timing 掩盖，CI 慢机复现）。留 pending 吃退避 + 硬错误 3 次兜底。
          this.logger.warn(`Embedding retry store failed for ${slice[i].entryId} (stays pending, backoff by claim): ${err}`);
        }
      }
    } catch (err) {
      const kind = this.classifyBatchError(err);
      if (kind === "busy") return { successCount, timeoutCount: 0, hardFailureCount: 0, laneBusy: true };
      if (kind === "timeout") {
        return { successCount, timeoutCount: slice.length, hardFailureCount: 0, laneBusy: false };
      }
      if (kind === "transient") {
        // 任务留 pending（claim 已 attempts+1 但不计 hard），下轮重领
        return { successCount, timeoutCount: 0, hardFailureCount: 0, laneBusy: false };
      }
      // hard：逐条记账（3 次 dead-letter）
      return this.recordHardFailures(slice, err);
    }
    return { successCount, timeoutCount: 0, hardFailureCount: 0, laneBusy: false };
  }

  /** hard 失败逐条记账（从 processBatchSlice 拆出压复杂度） */
  private async recordHardFailures(
    slice: EmbeddingTask[],
    err: unknown,
  ): Promise<{ successCount: number; timeoutCount: number; hardFailureCount: number; laneBusy: boolean }> {
    let hardFailureCount = 0;
    for (const task of slice) {
      await this.queue.markTaskAttemptFailed(task.entryId, err, this.maxAttempts);
      hardFailureCount++;
      this.logger.warn(`Embedding retry attempt ${task.attempts}/${this.maxAttempts} failed for ${task.entryId}: ${err}`);
    }
    return { successCount: 0, timeoutCount: 0, hardFailureCount, laneBusy: false };
  }

  /** 单条消费路径（旧逐条语义：salvage 双轨 + 错误分类） */
  private async processTasksSingly(
    slice: EmbeddingTask[],
  ): Promise<{ successCount: number; timeoutCount: number; hardFailureCount: number; laneBusy: boolean }> {
    let successCount = 0;
    let timeoutCount = 0;
    let hardFailureCount = 0;
    for (const task of slice) {
      try {
        const emb = await this.embedWithSalvage(task);
        await this.writer.storeEmbedding(task.entryId, emb);
        await this.queue.markTaskDone(task.entryId);
        successCount++;
      } catch (err) {
        const kind = await this.classifyTaskError(task, err);
        if (kind === "busy") return { successCount, timeoutCount, hardFailureCount, laneBusy: true };
        if (kind === "timeout") timeoutCount++;
        if (kind === "hard") hardFailureCount++;
        // transient：不计任何数，留 pending 重来
      }
    }
    return { successCount, timeoutCount, hardFailureCount, laneBusy: false };
  }

  /** 内容截断（与 StoreMemory.EMBED_MAX_CHARS 同口径，bge-m3 token 上限保护） */
  private truncateForStore(content: string): string {
    return content.length > EmbeddingRetryWorker.EMBED_MAX_CHARS
      ? content.slice(0, EmbeddingRetryWorker.EMBED_MAX_CHARS)
      : content;
  }

  /**
   * 批错误分类（整批语义，从 classifyTaskError 演化）。
   * busy（背压/槽位等待超时）终止本轮；timeout/transient 不计 attempts；
   * 其余 hard。
   */
  private classifyBatchError(err: unknown): "busy" | "timeout" | "transient" | "hard" {
    if (err instanceof EmbedBackpressureError) return "busy";
    // EmbedSlotTimeoutError extends EmbedTransientError——必须先判（槽位等待超时
    // 是 lane 饱和信号，终止本轮等下个 tick，不是 worker 坏）
    if (err instanceof Error && err.name === "EmbedSlotTimeoutError") return "busy";
    if (err instanceof EmbedTimeoutError) {
      this.logger.warn(`Embedding retry batch timeout (not counted, salvage may land): ${err}`);
      return "timeout";
    }
    if (err instanceof EmbedTransientError) {
      this.logger.warn(`Embedding retry batch transient failure (not counted): ${err}`);
      return "transient";
    }
    return "hard";
  }

  /**
   * F20261020slvg：单条任务的 embed——waitSlot 软限流 + salvage 双轨。
   * salvage 里 service 已包裹吞错；此处再兜一层：失败留 pending，下个 tick 重来。
   * F20261109epqst：等待上界由 service 默认（60s）承担——超时 reject
   * EmbedSlotTimeoutError（transient 类，不计 attempts）。
   */
  private async embedWithSalvage(task: EmbeddingTask): Promise<Float32Array> {
    return this.embeddingGateway.embed(this.truncateForStore(task.content), {
      waitSlot: true,
      priority: task.priority,
      salvage: (lateEmb) => {
        void (async () => {
          try {
            await this.writer.storeEmbedding(task.entryId, lateEmb);
            await this.queue.markTaskDone(task.entryId);
          } catch (err) {
            this.logger.warn(
              `Embedding retry salvage failed for ${task.entryId} (task stays pending): ${err}`,
            );
          }
        })();
      },
    });
  }

  /**
   * 错误分类与记账（单条路径保留，从 processClaimedTasks 拆出）。
   * 返回：busy（终止本轮）/ timeout（不计，salvage 双轨）/ transient（不计，洞 2）/
   * hard（markTaskAttemptFailed 记账，可能 dead-letter）。
   */
  private async classifyTaskError(
    task: EmbeddingTask,
    err: unknown,
  ): Promise<"busy" | "timeout" | "transient" | "hard"> {
    // F20261020slvg：背压——「现在忙」不是「这条坏了」，不计 attempts。
    if (err instanceof EmbedBackpressureError) {
      this.logger.warn(
        `Embedding retry lane busy for ${task.entryId} (not counted, stopping this round): ${err}`,
      );
      return "busy";
    }
    // F20261109epqst：槽位等待超时同背压待遇——lane 饱和，终止本轮
    if (err instanceof Error && err.name === "EmbedSlotTimeoutError") {
      this.logger.warn(
        `Embedding retry slot wait timeout for ${task.entryId} (not counted, stopping this round): ${err}`,
      );
      return "busy";
    }
    // F20261016ebrt：超时 ≠ 坏条目——不计入 maxAttempts，不 dead-letter。
    if (err instanceof EmbedTimeoutError) {
      this.logger.warn(
        `Embedding retry timeout for ${task.entryId} (not counted toward dead-letter, salvage may still land it): ${err}`,
      );
      return "timeout";
    }
    // F20261020slvg 对抗审视洞 2：瞬态错误（worker 重建/崩溃/熔断/send 失败）不计
    // attempts——claim 即 attempts+1 已被超时循环撑大，瞬态错误再计数会成批 dead-letter
    if (err instanceof EmbedTransientError) {
      this.logger.warn(
        `Embedding retry transient failure for ${task.entryId} (not counted, will retry): ${err}`,
      );
      return "transient";
    }
    await this.queue.markTaskAttemptFailed(task.entryId, err, this.maxAttempts);
    if (task.attempts >= this.maxAttempts) {
      this.logger.error(
        `Embedding retry dead-lettered for ${task.entryId} after ${task.attempts} attempts: ${err}`,
      );
    } else {
      this.logger.warn(
        `Embedding retry attempt ${task.attempts}/${this.maxAttempts} failed for ${task.entryId}: ${err}`,
      );
    }
    return "hard";
  }

  /**
   * F20261105embqg S3（对抗审视发现 3）：空闲回填——S3 闸门跳过的暗条目的
   * 运行时恢复路径。仅在队列完全清空时触发（不挤兑任何待消费任务），
   * 每 tick 上限 IDLE_BACKFILL_LIMIT 条、bulk 优先级（2）。与启动暗扫的
   * 区别：那里是一次性全量，这里是有界增量，队列再次升高时自然停手
   * （下个 tick 队列非空即不回填）。vec 禁用时 scanDarkEntries 语义不适
   * 用，跳过（与 tick 入口守卫一致）。
   */
  private async idleBackfillDarkEntries(): Promise<void> {
    if (typeof this.queue.pendingTaskCount !== "function") return;
    if (!(await this.reader.isVecEnabled())) return;
    if ((await this.queue.pendingTaskCount()) !== 0) return;

    const dark = await this.reader.scanDarkEntries(false);
    if (dark.total === 0) return;

    const limit = Math.min(dark.entries.length, EmbeddingRetryWorker.IDLE_BACKFILL_LIMIT);
    let refilled = 0;
    for (let i = 0; i < limit; i++) {
      const entry = dark.entries[i];
      await this.queue.enqueueRetry(
        entry.entryId,
        new Error("idle backfill from dark entries (S3 gate recovery)"),
        EMBED_TASK_PRIORITY.bulk,
      );
      refilled++;
    }
    this.logger.info(
      `Embedding idle backfill: re-enqueued ${refilled} dark entries (queue was empty)`,
      { action: "embedding_idle_backfill", refilled, darkTotal: dark.total },
    );
  }
}
