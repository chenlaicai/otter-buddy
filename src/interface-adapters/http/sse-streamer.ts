import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { Logger } from "@usecases/ports/logger";

/** SSE 事件 */
export interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}

/** 终端事件：发出后关闭 SSE 流（仅 stream.end，per-message 事件不再关闭流） */
const TERMINAL_EVENTS = new Set(["stream.end"]);

/**
 * 创建 SSE 流，返回响应和事件推送函数。
 * onAbort 在客户端断连时调用（用于中止 Agent 生成）。
 */
export function streamEvents(
  c: Context,
  onAbort: () => void,
  logger?: Logger,
): { response: Response; push: (event: SSEEvent) => void; close: () => void } {
  const requestId = c.get('requestId');
  const conversationId = c.req.param('id');
  const startTime = Date.now();
  const queue: SSEEvent[] = [];
  let waiting: (() => void) | null = null;
  let closed = false;

  // 记录 SSE 连接建立日志
  if (logger) {
    logger.info('SSE connection established', {
      requestId,
      conversationId,
    });
  }

  const push = (event: SSEEvent): void => {
    if (closed) return;
    queue.push(event);
    waiting?.();
  };

  const close = (): void => {
    closed = true;
    waiting?.();
  };

  const response = streamSSE(c, async (stream) => {
    stream.onAbort(() => {
      closed = true;
      logSSEClose(logger, requestId, conversationId, startTime, 'client_abort');
      onAbort();
      waiting?.();
    });

    await processSSEQueue(stream, queue, () => closed, () => {
      closed = true;
      logSSEClose(logger, requestId, conversationId, startTime, 'terminal_event');
    }, () => {
      waiting = null;
    });
  });

  return { response, push, close };
}

/**
 * 处理 SSE 事件队列。
 */
async function processSSEQueue(
  stream: { writeSSE: (data: { event: string; data: string }) => Promise<void> },
  queue: SSEEvent[],
  isClosed: () => boolean,
  onTerminalEvent: () => void,
  onWait: () => void,
): Promise<void> {
  while (!isClosed()) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 10) });
      onWait();
      continue;
    }

    const event = queue.shift()!;
    await stream.writeSSE({
      event: event.event,
      data: JSON.stringify(event.data),
    });

    if (TERMINAL_EVENTS.has(event.event)) {
      onTerminalEvent();
    }
  }

  // Drain remaining events that were queued before close signal
  while (queue.length > 0) {
    try {
      const event = queue.shift()!;
      await stream.writeSSE({
        event: event.event,
        data: JSON.stringify(event.data),
      });
    } catch {
      // Client disconnected or stream write failed — exit drain loop gracefully
      break;
    }
  }
}

/**
 * 记录 SSE 连接关闭日志。
 */
function logSSEClose(
  logger: Logger | undefined,
  requestId: string | undefined,
  conversationId: string | undefined,
  startTime: number,
  reason: string,
): void {
  if (!logger) return;

  const duration = Date.now() - startTime;
  const logData = {
    requestId,
    conversationId,
    duration,
    reason,
  };

  if (reason === 'client_abort') {
    logger.warn('SSE connection aborted', logData);
  } else {
    logger.info('SSE connection closed', logData);
  }
}
