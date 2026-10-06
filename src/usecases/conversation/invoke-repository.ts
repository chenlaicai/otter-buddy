import type {
  Invoke,
  InvokeStatus,
  InvokeEvent,
} from "@entities/conversation/invoke";

export interface GetInvokesOptions {
  limit?: number;
  before?: string;
  status?: InvokeStatus;
  otterId?: string;
}

/** 孤儿清理判据（#1241 pid 归属版）。
 *  清理 = 非本进程 pid（旧进程遗留，无论写入时间）；或 pid 恰好复用本 pid 但写入
 *  早于本进程 boot（pid 复用兜底——上代进程复用本 pid 时无法靠 pid 区分，
 *  但其遗留行写入必早于 boot）。两者 OR 关系，缺一不可：
 *  - 仅 pid 判据 → pid 复用场景漏清；
 *  - 仅时间戳 → 旧进程晚写入场景漏清（#1244 事故形态，正是本修复对象）。
 *  唯一豁免 = 本 pid 且写入晚于 boot（本进程活跃 invoke，不误杀）。 */
export interface FailRunningInvokesGuard {
  excludePid: number;
  beforeTs: string;
}

export interface InvokeRepository {
  // Invoke 生命周期
  createInvoke(invoke: Invoke): Promise<void>;
  updateInvokeStatus(
    invokeId: string,
    status: InvokeStatus,
    endedAt?: string,
  ): Promise<void>;
  updateInvokeTalkingStonePassedTo(
    invokeId: string,
    talkingStonePassedTo: string[],
  ): Promise<void>;
  updateInvokeToolCallCount(invokeId: string, count: number): Promise<void>;
  updateInvokeTokenUsage(
    invokeId: string,
    input: number,
    output: number,
    cacheRead?: number,
    cacheWrite?: number,
  ): Promise<void>;
  /** F20260914rtsp：更新末次 LLM 往返 ctx 窗口占用（invoke.tick 落库） */
  updateInvokeCtxWindowUsed(invokeId: string, ctxWindowUsed: number): Promise<void>;
  updateInvokeMetadata(invokeId: string, metadata: Record<string, unknown>): Promise<void>;

  // Invoke 查询
  getInvokeById(id: string): Promise<Invoke | null>;
  getInvokes(
    conversationId: string,
    options?: GetInvokesOptions,
  ): Promise<Invoke[]>;
  getActiveInvokeByOtterId(
    conversationId: string,
    otterId: string,
  ): Promise<Invoke | null>;
  getInvokeByTriggerEntryId(triggerEntryId: string): Promise<Invoke | null>;
  /** F20260917rscr 三点裁决③：查该獭在指定时刻之后的最新 invoke（「獭已恢复」判据
   *  数据源——中断后已有新 invoke 则恢复跳过，与来源无关） */
  getLatestInvokeByOtter(
    conversationId: string,
    otterId: string,
    afterStartedAt: string,
  ): Promise<Invoke | null>;
  /** F20260913ctlv 彻底切换：按 turn 查 invokes（tryCloseTurn 判据——turn 生命周期从 messages 剥离） */
  /**
   * F20260916b1ea 重建：重启 reconcile——running invokes 全部置 failed，
   *  并原子返回被标记行的详情（UPDATE...RETURNING，单条 SQL 消
   *  SELECT-then-UPDATE 竞态——恢复机制入队的数据源）。
   * #1241（F20261006opid）判据升级：beforeTs 时间戳守卫 → pid 归属判据
   *  （非本进程 pid 的 running = 旧进程遗留，无论写入时间均可精确清理）。
   *  时间戳守卫对事故形态（旧进程晚写入，started_at 晚于新进程 boot）永远跳过，
   *  10s 补跑与 1h 兜底同用 bootTs 空转；pid 判据无此盲区。beforeTs 保留作
   *  pid 复用兜底条件（见 FailRunningInvokesGuard）。
   */
  failRunningInvokes(
    failedAt: string,
    guard?: FailRunningInvokesGuard,
  ): Promise<
    Array<{
      id: string;
      conversationId: string;
      otterId: string;
      triggerEntryId: string | null;
    }>
  >;

  // InvokeEvent
  appendInvokeEvent(event: InvokeEvent): Promise<void>;
  getInvokeEvents(invokeId: string): Promise<InvokeEvent[]>;
  getInvokeEventsByInvokeIds(invokeIds: string[]): Promise<InvokeEvent[]>;
  getMaxEventSequenceNum(invokeId: string): Promise<number>;
}
