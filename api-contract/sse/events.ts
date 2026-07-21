/** SSE 事件类型映射 */
export type SSEEventMap = {
  "message.start": { messageId: string; otterId: string };
  "assistant_toolcall": { content: Array<Record<string, unknown>> };
  "tool.result": { toolName: string; result: unknown };
  "assistant_text": { content: Array<Record<string, unknown>> };
  "message.complete": { messageId: string; duration: string; ctx?: number; ctxMax?: number };
  "turn.complete": Record<string, never>;
  "agent.idle": Record<string, never>;
  "message.aborted": { messageId: string };
  "error": { message: string };
};

export type SSEEventType = keyof SSEEventMap;
export type SSEEventPayload<T extends SSEEventType> = SSEEventMap[T];
