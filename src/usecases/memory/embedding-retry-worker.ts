/**
 * F20260812mrcq Part 1 → F20261109epqst：embedding 后台队列消费者（原「重试 worker」）。
 *
 * F20261109epqst 后本 worker 是后台 embedding 的唯一消费者：
 * - store-memory 后台路径（文档 chunk）直接落库 embedding_tasks（不再预占 RAM 槽位）
 * - 实时路径失败/超时/槽位等待超时的任务也回流到本队列
 * - 本 worker 批量 claim → embedBatch 批量推理 → 逐条 storeEmbedding → markTaskDone
 *
 * 关键设计：
 * - tick 双重守卫：embeddingGateway.available && repo.isVecEnabled()。
 *   disableVec 后即使 worker 还在，也不消费 task（防 task 消失但 vec 没补）。
 * - 指数退避：claimPendingTasks 用 backoffSeconds 参数（30 → 60 → 120s 封顶 1h）。
 * - maxAttempts=3：3 次失败转 dead-letter，scanDarkEntries 默认不报告。
 * - 批处理：claim 的整批任务按 token 预算分组成 sub-batch 串行 embedBatch
 *   （service 层分片闸门兜底，这里先按批组装减少调用开销）。
 * - 生命周期：PatrolWorker 每 1h 调 tickNow()；有积压时 fire-and-forget 启动
 *   后台 drain 循环（不阻塞 patrol duty 串行链）；stop() 等待 inflight 收尾。
 *   app.ts dispose 调 stop() 避免 in-flight 写入已关闭 DB。
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
   * F20261016ebrt：单次 tick 最多连吃几批（积压泄洪）。50×20=1000 条/tick 上限。
   * F20261109epqst：drain 在后台 fire-and-forget 循环跑（不阻塞 patrol duty），
   * 该上限仍是单轮 drain 的安全边界。
   */
  private static readonly MAX_DRAIN_ROUNDS = 20;
  /**
   * F20261109epqst：后台 drain 轮间冷却——让出事件循环给实时请求（live 消息
   * 的 fireAndForgetEmbed 在槽位层优先级更高，但冷却让 IO/HTTP 也有呼吸窗口）。
   */
  private static readonly DRAIN_COOLDOWN_MS = 100;

  /**
   * F20261105embqg S3（对抗审视发现 3）：空闲回填单 tick 上限——S3 闸门跳过的
   * 暗条目在队列清空后的恢复路径。有界增量，与启动暗扫的一次性全量区分。
   */
  private static readonly IDLE_BACKFILL_LIMIT = 200;
  /**
   * F20261020slvg 对抗审视洞 4：单次 drain 时间预算。到点即收，下个 patrol 周期
   * tickNow 续吃（任务 claim 后未完成会按退避自动回队）。
   * F20261109epqst：drain 不再阻塞 patrol duty（后台运行），预算改为防单轮
   * 无限循环的硬边界；正常情况队列吃空即自然结束。
   */
  private static readonly MAX_DRAIN_MS = 10 * 60 * 1000;
  /**
   * F20261013ebps：连续全失败熔断——连续 N 轮 drain 全部失败（10/10 超时）
   * 说明 worker 已淹没（#1453），继续打只会加压。熔断后暂停消费，
   * 等下个 patrol 周期 tickNow 自动恢复（天然退避）。
   */
  private static readonly MAX_CONSECUTIVE_FULL_FAILURES = 3;
  private consecutiveFullFailures = 0;

  private timer: NodeJS.Timeout | null = null;
  private inflightTick: Promise<void> | null = null;
  /** F20261109epqst：后台 drain 循环（tickNow 触发，fire-and-forget 运行） */
  private drainLoop: Promise<void> | null = null;
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
        if (this.drainLoop) return; // 已在跑，无需重启
        this.drainLoop = this.runBackgroundDrain().catch(e =>
          this.logger.error(`EmbeddingRetryWorker background drain failed: ${e}`),
        ).finally(() => { this.drainLoop = null; });
        return;
      }
    } else {
      // 旧 mock 无 pendingTaskCount——直接 drain（兼容路径）
      if (this.drainLoop) return;
      this.drainLoop = this.runBackgroundDrain().catch(e =>
        this.logger.error(`EmbeddingRetryWorker background drain failed: ${e}`),
      ).finally(() => { this.drainLoop = null; });
      return;
    }

    // F20261105embqg S3（对抗审视发现 3）：空闲回填——高水位被跳过的暗条目
    // 不再只能等下次 sync/重启：队列空了才回填（有界）。详见 idleBackfillDarkEntries。
    await this.idleBackfillDarkEntries();
  }

  /**
   * F20261109epqst：后台 drain 循环——持续 claim → 批量消费，直到队列见底/
   * 达轮次/时间预算/停止。fire-and-forget 运行（tickNow 立即返回，patrol
   * duty 不被饿死）；stop() 会 await 本循环收尾。
   */
  private async runBackgroundDrain(): Promise<void> {
    const drainDeadline = Date.now() + EmbeddingRetryWorker.MAX_DRAIN_MS;
    const totals = { claimed: 0, succeeded: 0, timedOut: 0, hardFailed: 0 };
    for (let round = 0; round < EmbeddingRetryWorker.MAX_DRAIN_ROUNDS; round++) {
      if (this.haltRequested) break;
      const claimed = await this.queue.claimPendingTasks(EmbeddingRetryWorker.BATCH_LIMIT);
      if (claimed.length === 0) {
        this.consecutiveFullFailures = 0;
        break;
      }
      totals.claimed += claimed.length;

      const stats = await this.processClaimedTasks(claimed);
      totals.succeeded += stats.successCount;
      totals.timedOut += stats.timeoutCount;
      totals.hardFailed += stats.hardFailureCount;

      if (this.shouldStopDraining(claimed, stats, drainDeadline)) break;
      // 轮间冷却：让出事件循环给实时请求/IO
      await new Promise<void>((resolve) => setTimeout(resolve, EmbeddingRetryWorker.DRAIN_COOLDOWN_MS));
    }
    if (totals.claimed > 0) {
      this.logger.info("Embedding retry drain done", {
        action: "embedding_retry_drain_summary",
        claimed: totals.claimed,
        succeeded: totals.succeeded,
        timedOut: totals.timedOut,
        hardFailed: totals.hardFailed,
      });
    }
  }

  /**
   * drain 轮间停机判定（从 drainRounds 拆出压复杂度）。
   * F20261020slvg 对抗审视洞 3：熔断吸收态修正——「全失败」只数硬失败
   * （markTaskAttemptFailed 路径）。纯超时轮是「lane 慢」的正常路径（salvage
   * 还在后台落库），计入熔断会让 retry worker 在慢机器上 3 轮后自我砖化。
   */
  private shouldStopDraining(
    claimed: EmbeddingTask[],
    stats: { successCount: number; hardFailureCount: number; laneBusy: boolean },
    drainDeadline: number,
  ): boolean {
    if (stats.successCount === 0 && stats.hardFailureCount > 0) {
      this.consecutiveFullFailures++;
      if (this.consecutiveFullFailures >= EmbeddingRetryWorker.MAX_CONSECUTIVE_FULL_FAILURES) {
        this.logger.warn(
          `EmbeddingRetryWorker: ${this.consecutiveFullFailures} consecutive full-failure ticks, circuit breaker will open`,
          { action: "embedding_retry_circuit_break_warning" },
        );
        return true;
      }
    } else {
      this.consecutiveFullFailures = 0;
    }
    if (stats.laneBusy) return true; // lane 占用（同步批/慢请求在途），下个 tick 再战
    if (Date.now() > drainDeadline) return true; // 时间预算耗尽，下个 tick 续
    // 没吃满一批：队列已见底，结束本轮
    return claimed.length < EmbeddingRetryWorker.BATCH_LIMIT;
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
   * - 批成功后逐条 storeEmbedding；单条写库失败 → enqueueRetry 回队（不丢）
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
          // 写库失败：任务回队不丢（幂等重试；ON CONFLICT 保留 attempts）
          this.logger.warn(`Embedding retry store failed for ${slice[i].entryId} (re-queued): ${err}`);
          await this.queue.enqueueRetry(slice[i].entryId, err, slice[i].priority);
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
