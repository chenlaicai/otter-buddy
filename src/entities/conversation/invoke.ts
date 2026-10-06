/** Invoke 实体：一次獭行动的完整生命周期 */

/** Invoke 状态机 */
export type InvokeStatus = "running" | "completed" | "failed" | "aborted";

/** Invoke 实体 */
export interface Invoke {
  id: string;
  conversationId: string;
  otterId: string;
  status: InvokeStatus;
  /** 触发本 invoke 的 entry id（invoke_start 或信号触发） */
  triggerEntryId: string | null;
  /** yield 时写入的行动权传递目标（JSON array） */
  talkingStonePassedTo: string[] | null;
  startedAt: string;
  endedAt: string | null;
  /** 本次 invoke 的工具调用计数 */
  toolCallCount: number;
  tokenUsageInput: number | null;
  tokenUsageOutput: number | null;
  /** F20260914rtsp：末次 LLM 往返的上下文窗口占用（usage.totalTokens 快照，含 cacheRead/cacheWrite）。
   *  右栏「休息中 · xx/xx」与 Session 弹窗 invoke 摘要的数据源；null = 无数据（usage 缺失或旧数据） */
  ctxWindowUsed: number | null;
  /** #1241：创建本 invoke 的进程 pid（孤儿判据——非本进程 pid 的 running = 旧进程遗留）。
   *  null = pid 列引入前的存量行（启动 reconcile 无条件清理）。
   *  必填字段而非可选：防新增构造点漏写（漏写会被启动 reconcile 误杀，编译期强制補齐） */
  pid: number | null;
  /** 扩展字段（JSON） */
  metadata: Record<string, unknown> | null;
}

/** Invoke 事件类型 */
export type InvokeEventType = "assistant_text" | "assistant_toolcall" | "tool_result" | "error" | "speak" | "user_injection";

/** Invoke 事件实体（流式过程记录） */
export interface InvokeEvent {
  id: string;
  invokeId: string;
  eventType: InvokeEventType;
  payload: Record<string, unknown>;
  sequenceNum: number;
  createdAt: string;
}

/** Invoke 是否处于终态 */
export function isTerminalInvokeStatus(status: InvokeStatus): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

/** Invoke 是否正在运行 */
export function isRunningInvoke(status: InvokeStatus): boolean {
  return status === "running";
}
