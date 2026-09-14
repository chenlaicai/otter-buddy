/**
 * F20260913ctlv: Invoke DTO（Session 弹窗 + 右侧栏獭状态面板数据源）
 * 对应后端 Invoke/InvokeEvent 实体（src/entities/conversation/invoke.ts）
 */

/** invoke 状态机（与后端 InvokeStatus 对齐） */
export type InvokeStatusDTO = "running" | "completed" | "failed" | "aborted";

/** invoke 记录 DTO（一次獭行动的完整生命周期） */
export interface InvokeDTO {
  id: string;
  conversationId: string;
  otterId: string;
  status: InvokeStatusDTO;
  /** 触发本 invoke 的 entry id */
  triggerEntryId: string | null;
  /** yield 时写入的行动权传递目标 */
  talkingStonePassedTo: string[] | null;
  startedAt: string;
  endedAt: string | null;
  /** 本次 invoke 的工具调用计数 */
  toolCallCount: number;
  tokenUsageInput: number | null;
  tokenUsageOutput: number | null;
}

/** invoke 事件类型（流式过程记录） */
export type InvokeEventTypeDTO =
  | "assistant_text"
  | "assistant_toolcall"
  | "tool_result"
  | "error"
  | "speak";

/** invoke 事件 DTO（Session 弹窗展开后的流式过程条目） */
export interface InvokeEventDTO {
  id: string;
  invokeId: string;
  eventType: InvokeEventTypeDTO;
  payload: Record<string, unknown>;
  sequenceNum: number;
  createdAt: string;
}

/** invoke 列表响应（GET /api/conversations/:id/invokes） */
export interface InvokeListResponseDTO {
  invokes: InvokeDTO[];
  hasMore: boolean;
}

/** invoke 事件列表响应（GET /api/invokes/:id/events） */
export interface InvokeEventsResponseDTO {
  invoke: InvokeDTO;
  events: InvokeEventDTO[];
}
