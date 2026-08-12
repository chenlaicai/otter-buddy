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
import type { MemoryRepository } from "./memory-repository";
import type { EmbeddingGateway } from "./embedding-gateway";
import type { Logger } from "@usecases/ports/logger";

export class EmbeddingRetryWorker {
  /** bge-m3 8192 tokens 上限的 ~75%（与 StoreMemory.EMBED_MAX_CHARS 一致） */
  private static readonly EMBED_MAX_CHARS = 6000;
  /** 每次 tick 认领的任务上限 */
  private static readonly BATCH_LIMIT = 10;

  private timer: NodeJS.Timeout | null = null;
  private inflightTick: Promise<void> | null = null;
  private stopped = true;

  constructor(
    private readonly repo: MemoryRepository,
    private readonly embeddingGateway: EmbeddingGateway,
    private readonly logger: Logger,
    private readonly intervalMs: number = 30_000,
    private readonly maxAttempts: number = 3,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.inflightTick = this.tick().catch(e =>
        this.logger.error(`EmbeddingRetryWorker tick failed: ${e}`),
      );
    }, this.intervalMs);
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
    if (!this.repo.isVecEnabled()) return;

    // claimPendingTasks 内置指数退避（30/60/120/300/3600s）
    const claimed = await this.repo.claimPendingTasks(EmbeddingRetryWorker.BATCH_LIMIT);
    if (claimed.length === 0) return;

    for (const task of claimed) {
      // entry 已被删除（content 为空字符串）：跳过，task 留着等下次 scanDarkEntries 清理
      if (!task.content) {
        this.logger.warn(`EmbeddingRetryWorker: entry ${task.entryId} vanished, marking task dead`);
        await this.repo.markTaskAttemptFailed(task.entryId, new Error("entry deleted"), this.maxAttempts);
        continue;
      }

      try {
        const truncated = task.content.length > EmbeddingRetryWorker.EMBED_MAX_CHARS
          ? task.content.slice(0, EmbeddingRetryWorker.EMBED_MAX_CHARS)
          : task.content;
        const emb = await this.embeddingGateway.embed(truncated);
        await this.repo.storeEmbedding(task.entryId, emb);
        await this.repo.markTaskDone(task.entryId);
      } catch (err) {
        await this.repo.markTaskAttemptFailed(task.entryId, err, this.maxAttempts);
        // 检查是否转 dead
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
  }
}
