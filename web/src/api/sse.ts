import type { SSEEventMap, SSEEventType } from '@contract/sse/events'

export type SSEHandler<T extends SSEEventType = SSEEventType> = (event: T, data: SSEEventMap[T]) => void

/**
 * 消费 POST SSE 流（fetch + ReadableStream）。
 * 因为 SSE 端点是 POST，不能用 EventSource。
 */
export function consumeSSE(
  response: Response,
  handlers: Partial<{ [K in SSEEventType]: (data: SSEEventMap[K]) => void }>,
  opts?: { onError?: (err: Error) => void; onDone?: () => void },
): AbortController {
  const ctrl = new AbortController()

  if (!response.ok || !response.body) {
    opts?.onError?.(new Error(`SSE request failed: ${response.status}`))
    return ctrl
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  /** 事件名跨 chunk 保持：event: 行与 data: 行可能分属不同 read chunk，
   *  声明在循环内会在 chunk 边界丢失事件名导致整帧静默丢弃（F20260819spyd） */
  let currentEvent = ''

  ;(async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            const rawData = line.slice(5).trim()
            if (currentEvent && rawData) {
              try {
                const data = JSON.parse(rawData)
                const handler = handlers[currentEvent as SSEEventType] as ((d: unknown) => void) | undefined
                handler?.(data)
              } catch {
                console.warn('[SSE] malformed JSON:', rawData.slice(0, 80))
              }
            }
          }
        }
      }
      opts?.onDone?.()
    } catch (err) {
      if (!ctrl.signal.aborted) {
        opts?.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    }
  })()

  return ctrl
}
