import { describe, it, expect, beforeEach } from 'vitest'
import type { LocalMessage } from './mappers'

/**
 * 批量更新逻辑的纯函数测试。
 * 
 * 由于 batchUpdateMessages 和 flushBatchUpdates 依赖 React state（setAllMessages），
 * 这里测试的是它们的纯函数逻辑：pendingUpdatesRef 的 Map-overwrite 语义。
 */

function msg(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id: 'm1', st: 'otter', si: 'otter-1', content: 'hello',
    status: 'completed', ts: '2026-07-24T00:00:00Z', dur: null,
    ...overrides,
  }
}

describe('批量更新逻辑（纯函数语义）', () => {
  let pendingUpdates: Map<string, LocalMessage[]>
  let allMessages: Record<string, LocalMessage[]>

  beforeEach(() => {
    pendingUpdates = new Map()
    allMessages = {
      'conv-1': [msg({ id: 'm1', content: 'msg1' }), msg({ id: 'm2', content: 'msg2' })],
      'conv-2': [msg({ id: 'm3', content: 'msg3' })],
    }
  })

  /** 模拟 batchUpdateMessages 的核心逻辑 */
  function batchUpdateMessages(convId: string, updater: (prev: LocalMessage[]) => LocalMessage[]) {
    const current = allMessages[convId] || []
    const updated = updater(current)
    if (updated === current) return
    pendingUpdates.set(convId, updated)
  }

  /** 模拟 flushBatchUpdates 的核心逻辑 */
  function flushBatchUpdates() {
    if (pendingUpdates.size === 0) return
    const updates = new Map(pendingUpdates)
    pendingUpdates.clear()
    allMessages = { ...allMessages }
    for (const [convId, msgs] of updates) {
      allMessages[convId] = msgs
    }
  }

  it('同一 convId 的多次 batchUpdateMessages，只有最后一次的 updated 被 flush', () => {
    // 注意：在真实代码中，batchUpdateMessages 的 setAllMessages 返回 prev，state 不会变化
    // 所以同一 50ms 窗口内的多次 batchUpdateMessages 调用，updater 读取的 prev 是相同的
    
    // 第一次更新：添加消息
    batchUpdateMessages('conv-1', (list) => [...list, msg({ id: 'm4', content: 'msg4' })])
    expect(pendingUpdates.get('conv-1')?.map(m => m.id)).toEqual(['m1', 'm2', 'm4'])

    // 第二次更新：替换消息（updater 读取的 list 是原始 state，没有 m4）
    batchUpdateMessages('conv-1', (list) => list.map(m => m.id === 'm1' ? { ...m, content: 'updated' } : m))
    // 注意：因为 updater 读取的 list 是原始 state（['m1', 'm2']），所以返回的 updated 也是 ['m1', 'm2']
    // 这会覆盖 Map 中的条目，丢失第一次更新
    expect(pendingUpdates.get('conv-1')?.map(m => m.id)).toEqual(['m1', 'm2'])
    expect(pendingUpdates.get('conv-1')?.find(m => m.id === 'm1')?.content).toBe('updated')

    // Flush：只有最后一次更新生效（丢失了 m4）
    flushBatchUpdates()
    expect(allMessages['conv-1'].map(m => m.id)).toEqual(['m1', 'm2'])
    expect(allMessages['conv-1'].find(m => m.id === 'm1')?.content).toBe('updated')
    expect(pendingUpdates.size).toBe(0)
  })

  it('flushBatchUpdates 用存储值直接覆盖 state', () => {
    // 模拟 state 在存储后变化
    batchUpdateMessages('conv-1', (list) => [...list, msg({ id: 'm4', content: 'msg4' })])
    
    // 模拟 state 被外部修改（如轮询更新）
    allMessages['conv-1'] = [msg({ id: 'm1', content: 'external-update' })]
    
    // Flush：用存储的值覆盖，丢失外部更新
    flushBatchUpdates()
    expect(allMessages['conv-1'].map(m => m.id)).toEqual(['m1', 'm2', 'm4'])
    expect(allMessages['conv-1'].find(m => m.id === 'm1')?.content).toBe('msg1') // 存储的值，不是 external-update
  })

  it('跨 convId 的批量更新正确性', () => {
    batchUpdateMessages('conv-1', (list) => [...list, msg({ id: 'm4', content: 'msg4' })])
    batchUpdateMessages('conv-2', (list) => [...list, msg({ id: 'm5', content: 'msg5' })])
    
    expect(pendingUpdates.get('conv-1')?.map(m => m.id)).toEqual(['m1', 'm2', 'm4'])
    expect(pendingUpdates.get('conv-2')?.map(m => m.id)).toEqual(['m3', 'm5'])
    
    flushBatchUpdates()
    expect(allMessages['conv-1'].map(m => m.id)).toEqual(['m1', 'm2', 'm4'])
    expect(allMessages['conv-2'].map(m => m.id)).toEqual(['m3', 'm5'])
  })

  it('updater 返回相同引用时不存入 Map', () => {
    batchUpdateMessages('conv-1', (list) => list) // 返回相同引用
    expect(pendingUpdates.size).toBe(0) // 不存入 Map
  })

  it('flushBatchUpdates 在 Map 为空时不做任何操作', () => {
    const original = { ...allMessages }
    flushBatchUpdates()
    expect(allMessages).toEqual(original) // 不变
  })

  it('同一 convId 的多次更新，只有最后一次的 updated 被 flush（终态事件兜底）', () => {
    // 注意：在真实代码中，batchUpdateMessages 的 setAllMessages 返回 prev，state 不会变化
    // 所以同一 50ms 窗口内的多次 batchUpdateMessages 调用，updater 读取的 prev 是相同的
    // 这就是为什么 Map-overwrite 会导致中间态丢失
    
    // 模拟 message.start 事件
    batchUpdateMessages('conv-1', (list) => [...list, msg({ id: 'm4', content: 'streaming', status: 'streaming' })])
    
    // 模拟 assistant_text 事件（同一 50ms 窗口内，updater 读取的 list 是原始 state）
    batchUpdateMessages('conv-1', (list) => list.map(m => m.id === 'm4' ? { ...m, content: 'streaming...' } : m))
    
    // 模拟 message.complete 事件（同一 50ms 窗口内，updater 读取的 list 是原始 state）
    batchUpdateMessages('conv-1', (list) => list.map(m => m.id === 'm4' ? { ...m, content: 'final', status: 'completed' } : m))
    
    // Flush：只有 message.complete 的更新生效（Map-overwrite 语义）
    flushBatchUpdates()
    // 注意：m4 不存在，因为第二次和第三次 updater 读取的 list 没有 m4
    // 这就是中间态丢失的真实场景
    expect(allMessages['conv-1'].find(m => m.id === 'm4')).toBeUndefined()
    // 但终态事件（message.complete）会在下一个 50ms 窗口到达时修正
  })
})
