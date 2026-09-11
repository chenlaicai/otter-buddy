/**
 * SSE 事件类型映射
 *
 * F20260910ctlv 彻底切换：时间线模型唯一事件集。
 * - entry.*：时间线条目（speak/user/system/invoke 边界/yield/终态投影）
 * - invoke.*：invoke 生命周期（右栏状态面板数据源）
 * - agent.*：SDK 结构化事件（自动重试/压缩）
 * - 旧 message.* / speak.intermediate / assistant_text / assistant_toolcall / tool.result 已退役
 *   （流式过程数据源 = invoke_events 表，Session 弹窗经 GET /api/invokes/:id/events 拉取）
 */
export type SSEEventMap = {
  // ── 时间线条目事件（entries 表投影） ──
  /** user entry（用户发言气泡）。yieldTargets = 发言石目标（渲染「→ 目标」传递行） */
  "entry.user": { entryId: string; sequenceNum: number; senderId: string; body: string; createdAt: string; yieldTargets?: string[] };
  /** speak entry（獭气泡唯一来源）——speak 是原子工具调用（无流式生命周期），落库即 completed，
   *  单事件携带全量 body 一次性渲染完整气泡。原 entry.start 伪事件已退役（与 entry.speak 背靠背同数据，纯冗余）。 */
  "entry.speak": { entryId: string; invokeId: string; otterId?: string; body: string; otterName?: string; createdAt?: string };
  /** invoke 终态失败（invoke_end entry 对应投影） */
  "entry.failed": { entryId: string; invokeId: string; otterId: string; otterName?: string; body?: string };
  /** invoke 内自动重试（系统提醒 + 前端状态回退） */
  "entry.retry": { entryId: string; invokeId: string; otterId: string; otterName?: string; reason: string; attempt: number };
  /** invoke 被中止（invoke_end entry 对应投影） */
  "entry.aborted": { entryId: string; invokeId: string; otterId?: string; otterName?: string; body?: string };
  /** 系统条目（居中 system entry） */
  "entry.system": { entryId: string; content: string; seq: number };
  /** yield 条目（行动权传递，居中显示） */
  "entry.yield": { entryId: string; invokeId: string; otterId: string; otterName: string; yieldTargets: string[]; invokeEndEntryId?: string };

  // ── invoke 生命周期事件（invokes 表投影） ──
  /** invoke 开始（invoke 记录创建 + invoke_start entry） */
  "invoke.start": { invokeId: string; otterId: string; otterName: string; conversationId: string; startedAt: string; triggerEntryId?: string };
  /** invoke 结束（completed/failed/aborted）。duration 为 invoke 耗时（ms，number） */
  "invoke.end": { invokeId: string; otterId: string; otterName?: string; status: "completed" | "failed" | "aborted"; endedAt: string; duration?: number; toolCallCount?: number; tokenUsage?: { input: number; output: number }; invokeEndEntryId?: string; endBody?: string };

  // ── 通用事件（保留） ──
  "turn.complete": Record<string, never>;
  "agent.idle": Record<string, never>;
  "agent.retry_start": { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string };
  "agent.retry_end": { success: boolean; attempt: number; finalError?: string };
  "agent.compaction_start": { reason: "manual" | "threshold" | "overflow" };
  "agent.compaction_end": { reason: "manual" | "threshold" | "overflow"; aborted: boolean; willRetry: boolean; errorMessage?: string };
  "stream.end": Record<string, never>;
  "error": { message: string; invokeId?: string; otterId: string };
  "mention.feedback": { feedback: string };
};

export type SSEEventType = keyof SSEEventMap;
export type SSEEventPayload<T extends SSEEventType> = SSEEventMap[T];

/** SSE 事件信封：服务端推送/订阅流转的通用结构（event 名 + 负载） */
export interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}
