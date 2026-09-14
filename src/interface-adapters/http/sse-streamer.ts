import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { Logger } from "@usecases/ports/logger";
import type { SSEEvent } from "@contract/sse/events";

/** 终端事件：发出后关闭 SSE 流（仅 stream.end，per-message 事件不再关闭流） */
const TERMINAL_EVENTS = new Set(["stream.end"]);

/** Keep-alive 间隔（毫秒）：防止代理/浏览器关闭空闲 SSE 连接 */
const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * 创建 SSE 流，返回响应和事件推送函数。
 * onAbort 在客户端断连时调用（可选；注意断连不等于要中止 Agent 生成）。
 *
 * 内置 keep-alive：每 15 秒发送一条 SSE 注释（`:` 开头），防止反向代理或浏览器
 * 因空闲超时而关闭连接。
 */
export function streamEvents(
  c: Context,
  onAbort?: () => void,
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
    // Keep-alive: 定期发送 SSE 注释，防止空闲连接被关闭
    const keepAliveTimer = setInterval(() => {
      if (!closed) {
        stream.write(':\n\n').catch(() => { /* stream closed, ignore */ });
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);
    // #460：keep-alive timer unref，防 SSE 连接的 timer 阻止进程退出（僵尸进程根因之二）
    keepAliveTimer.unref?.();

    stream.onAbort(() => {
      closed = true;
      clearInterval(keepAliveTimer);
      logSSEClose(logger, requestId, conversationId, startTime, 'client_abort');
      onAbort?.();
      waiting?.();
    });

    await processSSEQueue(stream, queue, () => closed, () => {
      closed = true;
      clearInterval(keepAliveTimer);
      logSSEClose(logger, requestId, conversationId, startTime, 'terminal_event');
    }, (resolve) => {
      waiting = resolve;
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
  setWaiting: (resolve: () => void) => void,
): Promise<void> {
  while (!isClosed()) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => { setWaiting(resolve); });
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
