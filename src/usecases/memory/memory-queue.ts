/**
 * MemoryQueue：记忆队列 port。
 *
 * 从 MemoryRepository 拆出（E 三分），职责：
 * - 管理 embedding 重试队列
 * - 认领 pending 任务
 * - 标记任务完成/失败
 */

/**
 * F20261105embqg：任务优先级——claim 消费顺序与槽位唤醒顺序的依据。
 * 0=live 活消息（消息投影 embed，用户在场等检索）；1=normal 默认（fact/检索补算/retry 回流）；
 * 2=bulk 全量重算（文档同步 chunk/启动暗扫）——量最大且最可延后，积压时必须给 0/1 让路。
 * 定义在 port 层：usecases（store-memory）与 frameworks（task-queue）共用，依赖方向 frameworks→usecases。
 */
export const EMBED_TASK_PRIORITY = {
  live: 0,
  normal: 1,
  bulk: 2,
} as const;

/**
 * F20261105embqg S3：生产端水位闸门阈值——全量生产者（bulk）入队前查 pendingTaskCount，
 * 超过此值跳过本轮入队（暗条目可重扫，不丢）。判据单一（队列深度）：机械可测、
 * 行为可预期；约单 worker 1h 饱和吞吐量级，上线后按 tick_summary 观测再调。
 */
export const EMBED_QUEUE_HIGH_WATER = 2000;

export interface MemoryQueue {
  /**
   * F20260812mrcq Part 1：embedding 失败入队重试。
   * ON CONFLICT 保留 attempts（避免重置导致无限重试）。
   * status 强制为 'pending'（即使之前是 dead，重新入队复活）。
   * F20261105embqg S2b：priority 可选——0=live 消息 1=默认 2=bulk 重算，
   * 默认 1；重复入队不降优先级（首入队优先级保留）。
   */
  enqueueRetry(entryId: string, error: unknown, priority?: number): Promise<void>;
  /**
   * F20260812mrcq Part 1：认领 pending 任务（原子 UPDATE + RETURNING）。
   * attempts 自增 1，next_retry_at 按指数退避自动计算（30/60/120/300/3600s）。
   * 返回 [{entryId, content, attempts}]，content 从 memory_entries JOIN 获取。
   * 排除 status='dead'（除非 enqueueRetry 复活）。
   * F20261105embqg S2b：按 priority ASC, next_retry_at ASC 序 claim——
   * live 消息（0）先于 bulk 重算（2）出队，同级内退避时间序不变。
   *
   * 注意：相比 MemoryRepository 版本，有意省略 lastAttemptAt/createdAt——
   * embedding-retry-worker 只需 entryId + content + attempts 即可执行重试。
   */
  claimPendingTasks(limit: number): Promise<Array<{
    entryId: string;
    content: string;
    attempts: number;
    /** F20261105embqg（对抗审视发现 2）：优先级随任务返回，retry 执行端透传到槽位排队 */
    priority: number;
  }>>;
  /** F20260812mrcq Part 1：task 成功，删除 task 行 */
  markTaskDone(entryId: string): Promise<void>;
  /**
   * F20261105embqg S3：当前 pending 任务总数——生产端水位闸门判据。
   * 全量生产者（文档同步 chunk/启动暗扫）入队前查此值，超阈值跳过本轮。
   */
  pendingTaskCount?(): Promise<number>;
  /**
   * F20261109epqst：队列健康快照——可观测性（验收不变量：最老任务年龄/优先级
   * 分布周期可观测）。返回 pending 总数、最老 pending 任务年龄（秒，无任务为
   * null）、按优先级的分布。
   */
  pendingTaskStats?(): Promise<{
    pending: number;
    oldestAgeSeconds: number | null;
    byPriority: Record<number, number>;
  }>;
  /**
   * F20261020slvg：启动迁移用——把 pending 任务的 attempts 归零、next_retry_at 置为立即可重试。
   * 可选方法：claim 即 attempts+1 的语义被超时循环撑大后，存量任务需要一次性赦免
   * （对抗审视洞 2 处置；可选即为兼容未实现的 mock/旧 repo，语义上仅启动迁移使用）。
   */
  resetPendingAttempts?(): Promise<number>;
  /**
   * F20260812mrcq Part 1：task 失败，更新 last_error。
   * 若 attempts >= maxAttempts，status 转 'dead'。
   */
  markTaskAttemptFailed(entryId: string, error: unknown, maxAttempts: number): Promise<void>;
}
