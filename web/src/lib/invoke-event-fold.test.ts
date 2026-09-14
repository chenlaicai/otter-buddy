import { describe, it, expect } from 'vitest'
import { foldInvokeEvents } from './invoke-event-fold'
import type { InvokeEventDTO } from '@contract/api'

/** F20260914rtsp AT-8/AT-9/AT-12：折叠归并规则验证 */

function ev(id: string, eventType: string, payload: Record<string, unknown>, seq: number, ts = '2026-09-14T10:00:00Z'): InvokeEventDTO {
  return { id, invokeId: 'inv-1', eventType: eventType as InvokeEventDTO['eventType'], payload, sequenceNum: seq, createdAt: ts }
}

describe('foldInvokeEvents', () => {
  it('同一次工具调用：start + result 折叠为一行 call 步', () => {
    const steps = foldInvokeEvents([
      ev('e1', 'assistant_toolcall', { name: 'read', arguments: { path: 'a.ts' } }, 1),
      ev('e2', 'tool_result', { name: 'read', result: { output: 'file content' } }, 2),
    ])
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({
      kind: 'call', name: 'read', args: { path: 'a.ts' },
      result: { output: 'file content' }, pending: false, rawEventIds: ['e1', 'e2'],
    })
  })

  it('message_end 快照（content 数组形态）被丢弃不重复（AT-8）', () => {
    const steps = foldInvokeEvents([
      ev('e1', 'assistant_toolcall', { name: 'read', arguments: {} }, 1),
      ev('e2', 'tool_result', { name: 'read', result: 'ok' }, 2),
      // message_end 落库的 assistant_toolcall：payload.content 是块数组（快照形态）
      ev('e3', 'assistant_toolcall', { content: [{ type: 'toolCall', name: 'read' }] }, 3),
    ])
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ kind: 'call', name: 'read', rawEventIds: ['e1', 'e2'] })
  })

  it('同名工具连续调用：FIFO 配对不串（AT-12）', () => {
    const steps = foldInvokeEvents([
      ev('e1', 'assistant_toolcall', { name: 'search_memory', arguments: { query: 'A' } }, 1),
      ev('e2', 'assistant_toolcall', { name: 'search_memory', arguments: { query: 'B' } }, 2),
      ev('e3', 'tool_result', { name: 'search_memory', result: 'result-of-A' }, 3),
      ev('e4', 'tool_result', { name: 'search_memory', result: 'result-of-B' }, 4),
    ])
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({ kind: 'call', args: { query: 'A' }, result: 'result-of-A' })
    expect(steps[1]).toMatchObject({ kind: 'call', args: { query: 'B' }, result: 'result-of-B' })
  })

  it('孤儿 result（无 start）独立成 call 步（AT-9）', () => {
    const steps = foldInvokeEvents([
      ev('e1', 'tool_result', { name: 'bash', result: 'orphan output' }, 1),
    ])
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ kind: 'call', name: 'bash', result: 'orphan output', pending: false })
  })

  it('pending call（start 无 result，running 中）为待定态', () => {
    const steps = foldInvokeEvents([
      ev('e1', 'assistant_toolcall', { name: 'bash', arguments: { command: 'ls' } }, 1),
    ])
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ kind: 'call', name: 'bash', pending: true })
    expect((steps[0] as { result?: unknown }).result).toBeUndefined()
    expect((steps[0] as { tsEnd?: unknown }).tsEnd).toBeUndefined()
  })

  it('think / speak / error 直通', () => {
    const steps = foldInvokeEvents([
      ev('e1', 'assistant_text', { content: [{ type: 'text', text: '思考中' }] }, 1),
      ev('e2', 'speak', { body: '发言内容' }, 2),
      ev('e3', 'error', { message: 'boom' }, 3),
    ])
    expect(steps).toHaveLength(3)
    expect(steps[0]).toMatchObject({ kind: 'think', text: '思考中' })
    expect(steps[1]).toMatchObject({ kind: 'speak', body: '发言内容' })
    expect(steps[2]).toMatchObject({ kind: 'error', message: 'boom' })
  })

  it('错误结果识别：result.isError === true → isError', () => {
    const steps = foldInvokeEvents([
      ev('e1', 'assistant_toolcall', { name: 'write', arguments: {} }, 1),
      ev('e2', 'tool_result', { name: 'write', result: { output: '[错误] 落库失败', isError: true } }, 2),
    ])
    expect(steps[0]).toMatchObject({ kind: 'call', isError: true })
  })
})
