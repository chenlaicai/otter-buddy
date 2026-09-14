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
  /** 扩展字段（JSON） */
  metadata: Record<string, unknown> | null;
}

/** Invoke 事件类型 */
export type InvokeEventType = "assistant_text" | "assistant_toolcall" | "tool_result" | "error" | "speak";

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
