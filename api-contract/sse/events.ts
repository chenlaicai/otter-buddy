/** SSE 事件类型映射 */
export type SSEEventMap = {
  "message.start": { messageId: string; otterId: string };
  "assistant_toolcall": { messageId: string; content: Array<Record<string, unknown>> };
  "tool.result": { messageId: string; toolName: string; result: unknown };
  "assistant_text": { messageId: string; content: Array<Record<string, unknown>> };
  "message.complete": { messageId: string; duration: string; ctx?: number; ctxMax?: number };
  "message.failed": { messageId: string };
  "message.aborted": { messageId: string };
  "system.message": { messageId: string; content: string };
  "turn.complete": Record<string, never>;
  "agent.idle": Record<string, never>;
  "stream.end": Record<string, never>;
  "error": { message: string; messageId: string; otterId: string };
};

export type SSEEventType = keyof SSEEventMap;
export type SSEEventPayload<T extends SSEEventType> = SSEEventMap[T];
