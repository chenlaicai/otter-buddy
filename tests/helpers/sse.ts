/**
 * 共享 SSE 读取器。合并 tests/api/helpers.ts 与 subscribe-sse.test.ts 的两份实现。
 */

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** 读取 SSE 响应流直到结束，返回全部事件。实现源自 tests/api/helpers.ts readSSEEvents。 */
export async function readSSEEvents(res: Response): Promise<SseEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = "";
  let currentEvent = "";
  let currentData = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7);
      } else if (line.startsWith("data: ")) {
        currentData = line.slice(6);
      } else if (line === "" && currentEvent) {
        events.push({ event: currentEvent, data: JSON.parse(currentData) });
        currentEvent = "";
        currentData = "";
      }
    }
  }
  // Flush remaining buffer (may contain event: and/or data: lines without trailing \n\n)
  for (const line of buffer.split("\n")) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7);
    } else if (line.startsWith("data: ")) {
      currentData = line.slice(6);
    }
  }
  if (currentEvent && currentData) {
    events.push({ event: currentEvent, data: JSON.parse(currentData) });
  }

  return events;
}
