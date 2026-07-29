/** SSE 事件类型映射 */
export type SSEEventMap = {
  "message.start": { messageId: string; otterId: string; otterName: string; seq?: number; createdAt: string };
  "assistant_toolcall": { messageId: string; content: Array<Record<string, unknown>> };
  "tool.result": { messageId: string; toolName: string; result: unknown };
  "assistant_text": { messageId: string; content: Array<Record<string, unknown>> };
  "message.complete": { messageId: string; body: string; turnId: string; duration: string; ctx?: number; ctxMax?: number };
  "message.failed": { messageId: string; body?: string };
  "message.aborted": { messageId: string; body?: string; otterId?: string; otterName?: string };
  "system.message": { messageId: string; content: string };
  "turn.complete": Record<string, never>;
  "agent.idle": Record<string, never>;
  "stream.end": Record<string, never>;
  "error": { message: string; messageId: string; otterId: string };
};

export type SSEEventType = keyof SSEEventMap;
export type SSEEventPayload<T extends SSEEventType> = SSEEventMap[T];
