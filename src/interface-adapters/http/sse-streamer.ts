import { streamSSE } from "hono/streaming";
import type { Context } from "hono";

/** SSE 事件 */
export interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}

/** 终端事件：发出后关闭 SSE 流 */
const TERMINAL_EVENTS = new Set(["message.complete", "message.aborted", "error"]);

/**
 * 创建 SSE 流，返回响应和事件推送函数。
 * onAbort 在客户端断连时调用（用于中止 Agent 生成）。
 */
export function streamEvents(
  c: Context,
  onAbort: () => void,
): { response: Response; push: (event: SSEEvent) => void } {
  const queue: SSEEvent[] = [];
  let waiting: (() => void) | null = null;
  let closed = false;

  const push = (event: SSEEvent): void => {
    if (closed) return;
    queue.push(event);
    waiting?.();
  };

  const response = streamSSE(c, async (stream) => {
    stream.onAbort(() => {
      closed = true;
      onAbort();
      waiting?.();
    });

    while (!closed) {
      if (queue.length === 0) {
        await new Promise<void>((r) => { waiting = r; });
        waiting = null;
        continue;
      }

      const event = queue.shift()!;
      await stream.writeSSE({
        event: event.event,
        data: JSON.stringify(event.data),
      });

      if (TERMINAL_EVENTS.has(event.event)) {
        closed = true;
      }
    }
  });

  return { response, push };
}
