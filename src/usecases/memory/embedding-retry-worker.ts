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
import type { Logger } from "@usecases/ports/logger";

/** claimPendingTasks 返回的单条任务（MemoryQueue 接口为匿名类型，此处落名便于拆分函数签名） */
type EmbeddingTask = { entryId: string; content: string; attempts: number };

export class EmbeddingRetryWorker {
  /** bge-m3 8192 tokens 上限的 ~75%（与 StoreMemory.EMBED_MAX_CHARS 一致） */
  private static readonly EMBED_MAX_CHARS = 6000;
  /** 每次 tick 认领的任务上限 */
  private static readonly BATCH_LIMIT = 10;
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
   */
  async tickNow(): Promise<void> {
    await this.tick().catch(e =>
      this.logger.error(`EmbeddingRetryWorker tickNow failed: ${e}`),
    );
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

    const claimed = await this.queue.claimPendingTasks(EmbeddingRetryWorker.BATCH_LIMIT);
    if (claimed.length === 0) {
      this.consecutiveFullFailures = 0;
      return;
    }

    const successCount = await this.processClaimedTasks(claimed);

    // F20261013ebps：熔断计数——全失败才计数，有成功即重置
    if (successCount === 0 && claimed.length > 0) {
      this.consecutiveFullFailures++;
      if (this.consecutiveFullFailures >= EmbeddingRetryWorker.MAX_CONSECUTIVE_FULL_FAILURES) {
        this.logger.warn(
          `EmbeddingRetryWorker: ${this.consecutiveFullFailures} consecutive full-failure ticks, circuit breaker will open`,
          { action: "embedding_retry_circuit_break_warning" },
        );
      }
    } else {
      this.consecutiveFullFailures = 0;
    }
  }

  /** F20261013ebps：处理已 claim 的任务批次（从 tick 拆出，降复杂度） */
  private async processClaimedTasks(claimed: EmbeddingTask[]): Promise<number> {
    let successCount = 0;
    for (const task of claimed) {
      // entry 已被删除（content 为空字符串）：调 markTaskAttemptFailed（累计 3 次后转 dead）
      if (!task.content) {
        this.logger.warn(`EmbeddingRetryWorker: entry ${task.entryId} vanished, recording failed attempt`);
        await this.queue.markTaskAttemptFailed(task.entryId, new Error("entry deleted"), this.maxAttempts);
        continue;
      }

      try {
        const truncated = task.content.length > EmbeddingRetryWorker.EMBED_MAX_CHARS
          ? task.content.slice(0, EmbeddingRetryWorker.EMBED_MAX_CHARS)
          : task.content;
        const emb = await this.embeddingGateway.embed(truncated);
        await this.writer.storeEmbedding(task.entryId, emb);
        await this.queue.markTaskDone(task.entryId);
        successCount++;
      } catch (err) {
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
      }
    }
    return successCount;
  }
}
