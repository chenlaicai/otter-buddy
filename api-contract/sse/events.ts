/** SSE 事件类型映射（F20260910ctlv：新增 invoke/entry 事件） */
export type SSEEventMap = {
  // ── 旧事件（向后兼容，新前端走 entry.* 路径） ──
  "message.start": { messageId: string; otterId: string; otterName: string; seq?: number; createdAt: string };
  "speak.intermediate": { messageId: string; body: string; otterId?: string; otterName?: string; segmentId?: string; sequenceNum?: number };
  "message.complete": { messageId: string; otterId: string; otterName: string; body: string; turnId: string; duration: string; ctx?: number; ctxMax?: number; segments?: Array<{ id: string; body: string; sequenceNum: number }> };
  "message.failed": { messageId: string; otterId: string; otterName: string; body?: string };
  "message.retry": { messageId: string; otterId: string; otterName: string; reason: string; attempt: number };
  "message.aborted": { messageId: string; body?: string; otterId?: string; otterName?: string };
  "system.message": { messageId: string; content: string; seq: number };

  // ── 新事件（F20260910ctlv timeline 模型） ──
  /** invoke 开始（invoke 记录创建） */
  "invoke.start": { invokeId: string; otterId: string; otterName: string; conversationId: string; startedAt: string };
  /** invoke 结束（completed/failed/aborted） */
  "invoke.end": { invokeId: string; otterId: string; status: "completed" | "failed" | "aborted"; endedAt: string; toolCallCount?: number; tokenUsage?: { input: number; output: number } };
  /** speak entry 创建（取代 message.start） */
  "entry.start": { entryId: string; invokeId: string; otterId: string; otterName: string; seq?: number; createdAt: string };
  /** speak entry body 增量（取代 speak.intermediate） */
  "entry.speak": { entryId: string; invokeId: string; body: string; otterName?: string; segmentId?: string; sequenceNum?: number };
  /** speak entry 完成（取代 message.complete） */
  "entry.complete": { entryId: string; invokeId: string; otterId: string; otterName: string; body: string; turnId: string; duration: string; ctx?: number; ctxMax?: number; segments?: Array<{ id: string; body: string; sequenceNum: number }> };
  /** entry 失败（取代 message.failed） */
  "entry.failed": { entryId: string; invokeId: string; otterId: string; otterName: string; body?: string };
  /** entry 重试（取代 message.retry） */
  "entry.retry": { entryId: string; invokeId: string; otterId: string; otterName: string; reason: string; attempt: number };
  /** entry 中止（取代 message.aborted） */
  "entry.aborted": { entryId: string; invokeId: string; body?: string; otterId?: string; otterName?: string };
  /** 系统条目（取代 system.message） */
  "entry.system": { entryId: string; content: string; seq: number };
  /** yield 条目（行动权传递） */
  "entry.yield": { entryId: string; invokeId: string; otterId: string; otterName: string; yieldTargets: string[] };

  // ── 通用事件（保留） ──
  "assistant_toolcall": { messageId: string; content: Array<Record<string, unknown>> };
  "tool.result": { messageId: string; toolName: string; result: unknown };
  "assistant_text": { messageId: string; content: Array<Record<string, unknown>> };
  "turn.complete": Record<string, never>;
  "agent.idle": Record<string, never>;
  "agent.retry_start": { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string };
  "agent.retry_end": { success: boolean; attempt: number; finalError?: string };
  "agent.compaction_start": { reason: "manual" | "threshold" | "overflow" };
  "agent.compaction_end": { reason: "manual" | "threshold" | "overflow"; aborted: boolean; willRetry: boolean; errorMessage?: string };
  "stream.end": Record<string, never>;
  "error": { message: string; messageId: string; otterId: string };
  "mention.feedback": { feedback: string };
};

export type SSEEventType = keyof SSEEventMap;
export type SSEEventPayload<T extends SSEEventType> = SSEEventMap[T];

/** SSE 事件信封：服务端推送/订阅流转的通用结构（event 名 + 负载） */
export interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}
