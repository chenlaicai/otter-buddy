/** SSE 事件类型映射 */
export type SSEEventMap = {
  "message.start": { messageId: string; otterId: string; otterName: string; seq?: number; createdAt: string };
  "assistant_toolcall": { messageId: string; content: Array<Record<string, unknown>> };
  "tool.result": { messageId: string; toolName: string; result: unknown };
  "assistant_text": { messageId: string; content: Array<Record<string, unknown>> };
  /** speak 中间发言：agent 继续工作时的增量内容（speak+yield 拆分——speak 即时呈现，不结束回合）
   *  F-multi-speak-bubble: segmentId + sequenceNum 用于前端分段渲染
   */
  "speak.intermediate": { messageId: string; body: string; otterId?: string; otterName?: string; segmentId?: string; sequenceNum?: number };
  "message.complete": { messageId: string; otterId: string; otterName: string; body: string; turnId: string; duration: string; ctx?: number; ctxMax?: number; segments?: Array<{ id: string; body: string; sequenceNum: number }> };
  "message.failed": { messageId: string; otterId: string; otterName: string; body?: string };
  "message.aborted": { messageId: string; body?: string; otterId?: string; otterName?: string };
  "system.message": { messageId: string; content: string; seq: number };
  "turn.complete": Record<string, never>;
  "agent.idle": Record<string, never>;
  /** SDK auto-retry 进行中（R20260810piab 遗漏 1：透传 SDK 结构化事件） */
  "agent.retry_start": { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string };
  /** SDK auto-retry 结束 */
  "agent.retry_end": { success: boolean; attempt: number; finalError?: string };
  /** SDK 上下文压缩进行中 */
  "agent.compaction_start": { reason: "manual" | "threshold" | "overflow" };
  /** SDK 上下文压缩结束 */
  "agent.compaction_end": { reason: "manual" | "threshold" | "overflow"; aborted: boolean; willRetry: boolean; errorMessage?: string };
  "stream.end": Record<string, never>;
  "error": { message: string; messageId: string; otterId: string };
  /** @提及解析 feedback：目标退场或解析失败时通知用户 */
  "mention.feedback": { feedback: string };
};

export type SSEEventType = keyof SSEEventMap;
export type SSEEventPayload<T extends SSEEventType> = SSEEventMap[T];

/** SSE 事件信封：服务端推送/订阅流转的通用结构（event 名 + 负载） */
export interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}
