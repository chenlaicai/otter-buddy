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
  getInvokesByTurnId(turnId: string): Promise<Invoke[]>;
  /**
   * F20260916b1ea 重建：重启 reconcile——running invokes 全部置 failed，
   *  并原子返回被标记行的详情（UPDATE...RETURNING，单条 SQL 消
   *  SELECT-then-UPDATE 竞态——恢复机制入队的数据源）。
   */
  failRunningInvokes(
    failedAt: string,
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
