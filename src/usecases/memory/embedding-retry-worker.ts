/**
 * F20260812mrcq Part 1：embedding 失败重试 worker。
 *
 * store-memory.ts 的 fire-and-forget 失败后入 embedding_tasks 队列，
 * 本 worker 定时 tick 消费：claim → embed → storeEmbedding → markTaskDone。
 *
 * 关键设计：
 * - tick 双重守卫：embeddingGateway.available && repo.isVecEnabled()。
 *   disableVec 后即使 worker 还在，也不消费 task（防 task 消失但 vec 没补）。
 * - 指数退避：claimPendingTasks 用 backoffSeconds 参数（30 → 60 → 120s 封顶 1h）。
 * - maxAttempts=3：3 次失败转 dead-letter，scanDarkEntries 默认不报告。
 * - 生命周期：start() 启 setInterval；stop() clearInterval + await inflightTick。
 *   app.ts dispose 调 stop() 避免 in-flight 写入已关闭 DB。
 */
import type { MemoryReader } from "./memory-reader";
import type { MemoryWriter } from "./memory-writer";
import type { MemoryQueue } from "./memory-queue";
import type { EmbeddingGateway } from "./embedding-gateway";
import { EmbedTimeoutError, EmbedBackpressureError, EmbedTransientError } from "./embedding-gateway";
import type { Logger } from "@usecases/ports/logger";

/** claimPendingTasks 返回的单条任务（MemoryQueue 接口为匿名类型，此处落名便于拆分函数签名） */
type EmbeddingTask = { entryId: string; content: string; attempts: number };

export class EmbeddingRetryWorker {
  /** bge-m3 8192 tokens 上限的 ~75%（与 StoreMemory.EMBED_MAX_CHARS 一致） */
  private static readonly EMBED_MAX_CHARS = 6000;
  /**
   * 每次 tick 认领的任务上限。
   * F20261016ebrt：10 → 50——#948 闹钟瘦身把 tick 从 30s 调到 1h，却没调 BATCH_LIMIT，
   * 吞吐被打掉 120 倍（1200/时 → 10/时），1000 积压要 4 天才能吃完。
   * 50 条/tick × 1h = 50/时，配合下方 drain 循环可在一个 tick 内连吃多批。
   */
  private static readonly BATCH_LIMIT = 50;
  /** F20261016ebrt：单次 tick 最多连吃几批（积压泄洪）。50×20=1000 条/tick 上限 */
  private static readonly MAX_DRAIN_ROUNDS = 20;
  /**
   * F20261016slvg 对抗审视洞 4：单次 tick 时间预算。waitSlot 节流后 tick 时长由
   * worker 真实吞吐决定（2905 条 × 慢推理可达几十小时），而 PatrolWorker 串行
   * await 每个 duty——不设预算会把对账/信号扫描等其余 duty 全部饿死。
   * 到点即收，下个整点 tick 续吃（任务 claim 后未完成会按退避自动回队）。
   */
  private static readonly MAX_TICK_MS = 10 * 60 * 1000;
  /**
   * F20261013ebps：连续全失败熔断——连续 N 次 tick 全部失败（10/10 超时）
   * 说明 worker 已淹没（#1453），继续打只会加压。熔断后暂停消费，
   * 等下一个 interval 周期自动恢复（PatrolWorker 1h 驱动，天然退避）。
   */
  private static readonly MAX_CONSECUTIVE_FULL_FAILURES = 3;
  private consecutiveFullFailures = 0;

  private timer: NodeJS.Timeout | null = null;
  private inflightTick: Promise<void> | null = null;
  private stopped = true;

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
  }

  /**
   * 停止 worker：clearInterval + 等待 in-flight tick 完成（测试用）。
   * 测试中需要 await 保证 tick 完成后再断言 DB 状态。
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inflightTick) {
      await this.inflightTick;
    }
  }

  /**
   * 同步停止：仅 clearInterval，不等 in-flight。
   * app.ts dispose 用此版本（process.exit 后 in-flight Promise 随进程消亡）。
   */
  stopSync(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 事件驱动一次额外 tick（worker ready 后立即跑，不等 30s）。
   * bootstrap 在 embeddingGateway 'ready' 事件时调用。
   *
   * F20261016slvg：重入守卫——逐条 waitSlot 后单个 tick 可能跑几十分钟（吞吐由
   * worker 真实速度节流），PatrolWorker 下个小时再调 tickNow 会并发 tick。
   * claimPendingTasks 的 next_retry_at 退避天然挡重复 claim，此处显式守卫更干净。
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

    // F20261013ebps：熔断——连续 N 次 tick 全失败，暂停消费（worker 已淹，再打加压）
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

    // F20261016ebrt：积压泄洪 + F20261016slvg 洞 3/4/5 修正（详见 drainRounds 内注释）
    const totals = await this.drainRounds();
    // 对抗审视洞 5：tick 收尾打点——积压收敛的可观测抓手
    if (totals.claimed > 0) {
      this.logger.info("Embedding retry tick done", {
        action: "embedding_retry_tick_summary",
        claimed: totals.claimed,
        succeeded: totals.succeeded,
        timedOut: totals.timedOut,
        hardFailed: totals.hardFailed,
      });
    }
  }

  /**
   * F20261016ebrt：积压泄洪——吃满一批立即再 claim，直到队列见底或达轮次上限。
   * F20261016slvg：泄洪自节流——逐条 waitSlot 后节奏由 worker 真实吞吐决定，
   * 不再往忙 lane 灌请求；lane 满时终止本轮（不算失败）。
   * 对抗审视洞 4：tick 时间预算——waitSlot 节流后单个 tick 可跑几十小时，
   * PatrolWorker 串行 await duty 会全部饿死；到点即收，下个 tick 续。
   */
  private async drainRounds(): Promise<{ claimed: number; succeeded: number; timedOut: number; hardFailed: number }> {
    const tickDeadline = Date.now() + EmbeddingRetryWorker.MAX_TICK_MS;
    const totals = { claimed: 0, succeeded: 0, timedOut: 0, hardFailed: 0 };
    for (let round = 0; round < EmbeddingRetryWorker.MAX_DRAIN_ROUNDS; round++) {
      const claimed = await this.queue.claimPendingTasks(EmbeddingRetryWorker.BATCH_LIMIT);
      if (claimed.length === 0) {
        this.consecutiveFullFailures = 0;
        break;
      }
      totals.claimed += claimed.length;

      const stats = await this.processClaimedTasks(claimed, tickDeadline);
      totals.succeeded += stats.successCount;
      totals.timedOut += stats.timeoutCount;
      totals.hardFailed += stats.hardFailureCount;

      if (this.shouldStopDraining(claimed, stats, tickDeadline)) break;
    }
    return totals;
  }

  /**
   * drain 轮间停机判定（从 drainRounds 拆出压复杂度）。
   * F20261016slvg 对抗审视洞 3：熔断吸收态修正——「全失败」只数硬失败
   * （markTaskAttemptFailed 路径）。纯超时轮是「lane 慢」的正常路径（salvage
   * 还在后台落库），计入熔断会让 retry worker 在慢机器上 3 轮后自我砖化。
   */
  private shouldStopDraining(
    claimed: EmbeddingTask[],
    stats: { successCount: number; hardFailureCount: number; laneBusy: boolean },
    tickDeadline: number,
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
    if (Date.now() > tickDeadline) return true; // 时间预算耗尽，下个 tick 续
    // 没吃满一批：队列已见底，结束本轮
    return claimed.length < EmbeddingRetryWorker.BATCH_LIMIT;
  }

  /**
   * F20261013ebps：处理已 claim 的任务批次（从 tick 拆出，降复杂度）。
   *
   * F20261016slvg：
   * - 逐条 waitSlot——吞吐由 worker 真实速度节流（槽位占用到 worker 响应为止），
   *   不再往忙 lane 里塞请求。
   * - 传 salvage——超时只是「不再等」，worker 晚到的向量照样落库 + markTaskDone，
   *   根治「白算的向量无人消费 → 任务回队列 → 无限重算」的活锁环路。
   *   窗口内（salvage 完成前）任务仍 pending，下个 tick 可能重复算一次——
   *   storeEmbedding 幂等覆盖写，收敛不发散，接受。
   */
  private async processClaimedTasks(
    claimed: EmbeddingTask[],
    tickDeadline: number,
  ): Promise<{ successCount: number; timeoutCount: number; hardFailureCount: number; laneBusy: boolean }> {
    let successCount = 0;
    let timeoutCount = 0;
    let hardFailureCount = 0;
    for (const task of claimed) {
      // 对抗审视洞 4：时间预算耗尽即收（在任务边界检查，不中断在途请求）
      if (Date.now() > tickDeadline) break;

      // entry 已被删除（content 为空字符串）：调 markTaskAttemptFailed（累计 3 次后转 dead）
      if (!task.content) {
        this.logger.warn(`EmbeddingRetryWorker: entry ${task.entryId} vanished, recording failed attempt`);
        await this.queue.markTaskAttemptFailed(task.entryId, new Error("entry deleted"), this.maxAttempts);
        hardFailureCount++;
        continue;
      }

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

  /**
   * F20261016slvg：单条任务的 embed——waitSlot 软限流 + salvage 双轨。
   * salvage 里 service 已包裹吞错；此处再兜一层：失败留 pending，下个 tick 重来。
   */
  private async embedWithSalvage(task: EmbeddingTask): Promise<Float32Array> {
    const truncated = task.content.length > EmbeddingRetryWorker.EMBED_MAX_CHARS
      ? task.content.slice(0, EmbeddingRetryWorker.EMBED_MAX_CHARS)
      : task.content;
    return this.embeddingGateway.embed(truncated, {
      waitSlot: true,
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
   * 错误分类与记账（从 processClaimedTasks 拆出压复杂度）。
   * 返回：busy（终止本轮）/ timeout（不计，salvage 双轨）/ transient（不计，洞 2）/
   * hard（markTaskAttemptFailed 记账，可能 dead-letter）。
   */
  private async classifyTaskError(
    task: EmbeddingTask,
    err: unknown,
  ): Promise<"busy" | "timeout" | "transient" | "hard"> {
    // F20261016slvg：背压——「现在忙」不是「这条坏了」，不计 attempts。
    // 注：waitSlot 下正常不可达（等待循环与准入检查同同步段取同值），
    // 纯防御——防未来重构破坏原子性时把可恢复任务埋掉
    if (err instanceof EmbedBackpressureError) {
      this.logger.warn(
        `Embedding retry lane busy for ${task.entryId} (not counted, stopping this round): ${err}`,
      );
      return "busy";
    }
    // F20261016ebrt：超时 ≠ 坏条目——不计入 maxAttempts，不 dead-letter。
    // 超时是「这批太慢/worker 暂时忙」，3 次就埋掉会把可恢复条目永久暗化。
    // F20261016slvg：超时后 salvage 仍有机会把结果落库（双轨）。
    if (err instanceof EmbedTimeoutError) {
      this.logger.warn(
        `Embedding retry timeout for ${task.entryId} (not counted toward dead-letter, salvage may still land it): ${err}`,
      );
      return "timeout";
    }
    // F20261016slvg 对抗审视洞 2：瞬态错误（worker 重建/崩溃/熔断/send 失败）不计
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
}
