/** 领域错误类型（use case 层抛出，controller 层映射为 HTTP 状态码） */
export type DomainErrorKind =
  | "not_found"
  | "conflict"
  | "validation"
  | "forbidden";

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly kind: DomainErrorKind,
  ) {
    super(message);
  }
}

/** #654: session 锁获取超时错误的消息前缀（SimpleLockManager 抛出，全链路唯一判据）。
 *  Why 常量放 entities：错误在 frameworks/agent 产生、usecases/scheduler 消费，
 *  分层规则禁止 usecases import frameworks，判据必须落在双方可达的最内层。 */
export const SESSION_LOCK_TIMEOUT_MESSAGE = 'Lock acquire timeout for key: ';

/** #654: session 锁获取超时 = 并发冲突信号（非任务失败）。
 *  语义：SimpleLockManager 的 stealThresholdMs(5min) 会强占 stale 持有者，
 *  能等到 30s acquire 超时的持有者必然是活跃方（人工调查、并行任务等）——
 *  scheduler 侧应记 skipped 而非 failed，不计入 consecutiveFailures。 */
export class SessionLockConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLockConflictError';
  }
}

/** #654: 识别 session 锁冲突错误——类型化 instanceof 优先（新代码路径），
 *  message 前缀匹配兜底（failTerminal 将锁错误写进消息体后，scheduler 侧
 *  只能从错误字符串反推——见 scheduler-service assertNoFailedMessages）。 */
export function isSessionLockConflictError(err: unknown): boolean {
  if (err instanceof SessionLockConflictError) return true;
  return err instanceof Error && err.message.includes(SESSION_LOCK_TIMEOUT_MESSAGE);
}
