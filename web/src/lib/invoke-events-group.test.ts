import { describe, it, expect } from 'vitest'
import { groupInvokeEvents } from './invoke-events-group'
import type { InvokeEventDTO } from '@contract/api'

/** 构造 helper：sequenceNum 递增的事件序列 */
function evs(...items: Array<{ type: string; payload?: Record<string, unknown> }>): InvokeEventDTO[] {
  return items.map((it, i) => ({
    id: `ev-${i}`,
    invokeId: 'inv-1',
    eventType: it.type as InvokeEventDTO['eventType'],
    payload: it.payload ?? {},
    sequenceNum: i,
    createdAt: '2026-09-11T00:00:00.000Z',
  }))
}

describe('groupInvokeEvents', () => {
  it('assistant_toolcall + 紧邻 tool_result 聚合为一组（同名）', () => {
    const events = evs(
      { type: 'assistant_toolcall', payload: { name: 'read', arguments: { path: '/a' } } },
      { type: 'tool_result', payload: { name: 'read', result: { text: 'ok' } } },
    )
    const groups = groupInvokeEvents(events)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ kind: 'toolcall', name: 'read', resultError: false })
  })

  it('连续同名 assistant_toolcall 去重保留首条（start 快照 + message_end 快照同一次调用）', () => {
    const events = evs(
      { type: 'assistant_toolcall', payload: { name: 'bash', arguments: { command: 'ls' } } },
      { type: 'assistant_toolcall', payload: { name: 'bash', content: [{ name: 'bash', arguments: { command: 'ls' } }] } },
      { type: 'tool_result', payload: { name: 'bash', result: 'file1\nfile2' } },
    )
    const groups = groupInvokeEvents(events)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ kind: 'toolcall', name: 'bash' })
  })

  it('speak 调用段折叠为单条发言条目（start + speak + snapshot 三事件 → 1）', () => {
    const events = evs(
      { type: 'assistant_toolcall', payload: { name: 'speak', arguments: { body: 'hi' } } },
      { type: 'speak', payload: { body: 'hi', sequenceNum: 0 } },
      { type: 'assistant_toolcall', payload: { content: [{ name: 'speak', arguments: { body: 'hi' } }] } },
    )
    const groups = groupInvokeEvents(events)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ kind: 'single' })
    expect((groups[0] as { event: InvokeEventDTO }).event.eventType).toBe('speak')
  })

  it('连续两次 speak 各自成段（多段发言不串组）', () => {
    const events = evs(
      { type: 'assistant_toolcall', payload: { name: 'speak', arguments: { body: 'a' } } },
      { type: 'speak', payload: { body: 'a', sequenceNum: 0 } },
      { type: 'assistant_toolcall', payload: { name: 'speak', arguments: { body: 'b' } } },
      { type: 'speak', payload: { body: 'b', sequenceNum: 1 } },
    )
    const groups = groupInvokeEvents(events)
    expect(groups).toHaveLength(2)
    expect((groups[0] as { event: InvokeEventDTO }).event.payload).toMatchObject({ body: 'a' })
    expect((groups[1] as { event: InvokeEventDTO }).event.payload).toMatchObject({ body: 'b' })
  })

  it('speak 后接其他工具调用正常聚合', () => {
    const events = evs(
      { type: 'assistant_text', payload: { content: [{ type: 'text', text: 'thinking' }] } },
      { type: 'assistant_toolcall', payload: { name: 'speak', arguments: { body: 'hi' } } },
      { type: 'speak', payload: { body: 'hi', sequenceNum: 0 } },
      { type: 'assistant_toolcall', payload: { name: 'read', arguments: {} } },
      { type: 'tool_result', payload: { name: 'read', result: 'ok' } },
    )
    const groups = groupInvokeEvents(events)
    // assistant_text 单项 + speak 单项 + read 聚合组
    expect(groups).toHaveLength(3)
    expect(groups[0]).toMatchObject({ kind: 'single' })
    expect((groups[0] as { event: InvokeEventDTO }).event.eventType).toBe('assistant_text')
    expect((groups[1] as { event: InvokeEventDTO }).event.eventType).toBe('speak')
    expect(groups[2]).toMatchObject({ kind: 'toolcall', name: 'read' })
  })

  it('yield 工具调用正常聚合（terminate: true 结果）', () => {
    const events = evs(
      { type: 'assistant_toolcall', payload: { name: 'yield', arguments: { to: ['user'] } } },
      { type: 'tool_result', payload: { name: 'yield', result: { text: '[系统控制信号] 交棒成功，回合结束。', terminate: true } } },
    )
    const groups = groupInvokeEvents(events)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ kind: 'toolcall', name: 'yield', resultError: false })
  })

  it('isError 结果标记 resultError', () => {
    const events = evs(
      { type: 'assistant_toolcall', payload: { name: 'bash', arguments: { command: 'bad' } } },
      { type: 'tool_result', payload: { name: 'bash', result: { isError: true, text: 'boom' } } },
    )
    const groups = groupInvokeEvents(events)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ kind: 'toolcall', resultError: true })
  })

  it('名字不匹配的 tool_result 不合并（防御乱序）', () => {
    const events = evs(
      { type: 'assistant_toolcall', payload: { name: 'read', arguments: {} } },
      { type: 'tool_result', payload: { name: 'bash', result: 'other' } },
    )
    const groups = groupInvokeEvents(events)
    // read 组（无结果）+ bash 孤儿 tool_result 单项
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ kind: 'toolcall', name: 'read', endSeq: null })
    expect(groups[1]).toMatchObject({ kind: 'single' })
  })

  it('同名工具连续两次调用各自聚合（不串组）', () => {
    const events = evs(
      { type: 'assistant_toolcall', payload: { name: 'read', arguments: { path: '/1' } } },
      { type: 'tool_result', payload: { name: 'read', result: 'one' } },
      { type: 'assistant_toolcall', payload: { name: 'read', arguments: { path: '/2' } } },
      { type: 'tool_result', payload: { name: 'read', result: 'two' } },
    )
    const groups = groupInvokeEvents(events)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ kind: 'toolcall', name: 'read' })
    expect(groups[1]).toMatchObject({ kind: 'toolcall', name: 'read' })
  })

  it('空序列返回空', () => {
    expect(groupInvokeEvents([])).toEqual([])
  })
})
