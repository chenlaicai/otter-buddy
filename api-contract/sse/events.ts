/** SSE 事件类型映射 */
export type SSEEventMap = {
  "message.start": { messageId: string; otterId: string };
  "message.delta": { text: string };
  "tool.start": { toolName: string };
  "tool.result": { toolName: string; result: unknown };
  "message.complete": { messageId: string; duration: string; ctx?: number; ctxMax?: number };
  "turn.complete": Record<string, never>;
  "agent.idle": Record<string, never>;
  "message.aborted": { messageId: string };
  "error": { message: string };
};

export type SSEEventType = keyof SSEEventMap;
export type SSEEventPayload<T extends SSEEventType> = SSEEventMap[T];
