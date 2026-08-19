/**
 * MemoryQueue：记忆队列 port。
 *
 * 从 MemoryRepository 拆出（E 三分），职责：
 * - 管理 embedding 重试队列
 * - 认领 pending 任务
 * - 标记任务完成/失败
 */

export interface MemoryQueue {
  /**
   * F20260812mrcq Part 1：embedding 失败入队重试。
   * ON CONFLICT 保留 attempts（避免重置导致无限重试）。
   * status 强制为 'pending'（即使之前是 dead，重新入队复活）。
   */
  enqueueRetry(entryId: string, error: unknown): Promise<void>;
  /**
   * F20260812mrcq Part 1：认领 pending 任务（原子 UPDATE + RETURNING）。
   * attempts 自增 1，next_retry_at 按指数退避自动计算（30/60/120/300/3600s）。
   * 返回 [{entryId, content, attempts}]，content 从 memory_entries JOIN 获取。
   * 排除 status='dead'（除非 enqueueRetry 复活）。
   */
  claimPendingTasks(limit: number): Promise<Array<{
    entryId: string;
    content: string;
    attempts: number;
  }>>;
  /** F20260812mrcq Part 1：task 成功，删除 task 行 */
  markTaskDone(entryId: string): Promise<void>;
  /**
   * F20260812mrcq Part 1：task 失败，更新 last_error。
   * 若 attempts >= maxAttempts，status 转 'dead'。
   */
  markTaskAttemptFailed(entryId: string, error: unknown, maxAttempts: number): Promise<void>;
}
