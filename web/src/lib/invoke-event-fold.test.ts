import { describe, it, expect } from 'vitest'
import { foldInvokeEvents, type FoldedStep } from './invoke-event-fold'
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

  it('think / speak / error 直通（无同名 start 时 speak 不吸收）', () => {
    const steps = foldInvokeEvents([
      ev('e1', 'assistant_text', { content: [{ type: 'text', text: '思考中' }] }, 1),
      ev('e2', 'speak', { body: '发言内容' }, 2),
      ev('e3', 'error', { message: 'boom' }, 3),
    ])
    expect(steps).toHaveLength(3)
    expect(steps[0]).toMatchObject({ kind: 'think', text: '思考中' })
    expect(steps[1]).toMatchObject({ kind: 'speak', body: '发言内容', rawEventIds: ['e2'] })
    expect(steps[2]).toMatchObject({ kind: 'error', message: 'boom' })
  })

  it('speak 吸收：同名 start 步被发言事件吸收，不再出现假工具行（F20260914evdz）', () => {
    // 真实落库形态：speak 的 start 落 assistant_toolcall，end 被 event-mapping 特判落 speak 事件
    const steps = foldInvokeEvents([
      ev('e1', 'assistant_toolcall', { name: 'speak', arguments: { body: '发言内容' } }, 1),
      ev('e2', 'speak', { body: '发言内容' }, 2),
    ])
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ kind: 'speak', body: '发言内容', rawEventIds: ['e1', 'e2'] })
  })

  it('speak 吸收保留前后工具行顺序：被吸收的 start 不占位', () => {
    const steps = foldInvokeEvents([
      ev('e1', 'assistant_toolcall', { name: 'read', arguments: { path: 'a' } }, 1),
      ev('e2', 'tool_result', { name: 'read', result: 'ok' }, 2),
      ev('e3', 'assistant_toolcall', { name: 'speak', arguments: { body: '完成' } }, 3),
      ev('e4', 'speak', { body: '完成' }, 4),
      ev('e5', 'assistant_toolcall', { name: 'write', arguments: { path: 'b' } }, 5),
      ev('e6', 'tool_result', { name: 'write', result: 'done' }, 6),
    ])
    expect(steps).toHaveLength(3)
    expect(steps[1]).toMatchObject({ kind: 'speak', body: '完成' })
    expect(steps[0]).toMatchObject({ kind: 'call', name: 'read' })
    expect(steps[2]).toMatchObject({ kind: 'call', name: 'write' })
  })

  it('invokeEnded：未配对的 start 步标记 interrupted（已中断非执行中，F20260914evdz）', () => {
    const steps = foldInvokeEvents(
      [
        ev('e1', 'assistant_toolcall', { name: 'bash', arguments: { command: 'ls' } }, 1),
        ev('e2', 'assistant_toolcall', { name: 'speak', arguments: { body: '被打断' } }, 2),
        ev('e3', 'tool_result', { name: 'bash', result: 'ok' }, 3),
      ],
      { invokeEnded: true },
    )
    const speakPending = steps.find((s): s is Extract<FoldedStep, { kind: 'call' }> => s.kind === 'call' && s.name === 'speak')
    expect(speakPending).toMatchObject({ pending: false, interrupted: true })
    // bash 正常配对不受影响（无中断标记）
    const bashStep = steps[0] as Extract<FoldedStep, { kind: 'call' }>
    expect(bashStep).toMatchObject({ kind: 'call', name: 'bash', pending: false })
    expect(bashStep.interrupted).toBeUndefined()
  })

  it('无 invokeEnded：未配对 start 保持 pending（running 中真执行中）', () => {
    const steps = foldInvokeEvents([
      ev('e1', 'assistant_toolcall', { name: 'speak', arguments: { body: '还没轮到' } }, 1),
    ])
    const speakStep = steps[0] as Extract<FoldedStep, { kind: 'call' }>
    expect(speakStep).toMatchObject({ kind: 'call', name: 'speak', pending: true })
    expect(speakStep.interrupted).toBeUndefined()
  })

  it('错误结果识别：result.isError === true → isError', () => {
    const steps = foldInvokeEvents([
      ev('e1', 'assistant_toolcall', { name: 'write', arguments: {} }, 1),
      ev('e2', 'tool_result', { name: 'write', result: { output: '[错误] 落库失败', isError: true } }, 2),
    ])
    expect(steps[0]).toMatchObject({ kind: 'call', isError: true })
  })
})

describe('user_injection（F20260918sesp）', () => {
  it('user 步直通成步，插在真实时序位置（steer 可见）', () => {
    const steps = foldInvokeEvents([
      ev('u1', 'user_injection', { content: '把这个文件改完' }, 1),
      ev('e1', 'assistant_toolcall', { name: 'read', arguments: { path: 'a.ts' } }, 2),
      ev('e2', 'tool_result', { name: 'read', result: 'content' }, 3),
      ev('u2', 'user_injection', { content: '【急讯 msg:x】来自 chen：先别改文件，等一下' }, 4),
      ev('e3', 'assistant_toolcall', { name: 'bash', arguments: { command: 'ls' } }, 5),
    ])
    expect(steps).toHaveLength(4)
    expect(steps[0]).toMatchObject({ kind: 'user', text: '把这个文件改完', rawEventIds: ['u1'] })
    expect(steps[2]).toMatchObject({ kind: 'user', text: '【急讯 msg:x】来自 chen：先别改文件，等一下' })
    expect(steps[3]).toMatchObject({ kind: 'call', name: 'bash', pending: true })
  })

  it('旧数据（无 user_injection）折叠结果不变', () => {
    const steps = foldInvokeEvents([
      ev('e1', 'assistant_toolcall', { name: 'read', arguments: {} }, 1),
      ev('e2', 'tool_result', { name: 'read', result: 'ok' }, 2),
    ])
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ kind: 'call', name: 'read' })
  })
})
