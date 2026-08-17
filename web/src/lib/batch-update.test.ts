import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MessageBatcher } from './batch-update'
import type { LocalMessage } from './mappers'

/**
 * F20260814qswp：直接测试真实实现 MessageBatcher。
 * 旧测试文件复刻了一份实现副本做断言（影子测试），且把"窗口内更新丢失"
 * 当作预期行为固化——本文件改为对真实代码断言正确语义。
 */

function msg(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id: 'm1', st: 'otter', si: 'otter-1', content: 'hello',
    status: 'completed', ts: '2026-07-24T00:00:00Z', dur: null,
    ...overrides,
  }
}

describe('MessageBatcher', () => {
  let base: Record<string, LocalMessage[]>
  let applied: Array<Map<string, LocalMessage[]>>
  let batcher: MessageBatcher

  beforeEach(() => {
    vi.useFakeTimers()
    base = {
      'conv-1': [msg({ id: 'm1', content: 'msg1' }), msg({ id: 'm2', content: 'msg2' })],
      'conv-2': [msg({ id: 'm3', content: 'msg3' })],
    }
    applied = []
    batcher = new MessageBatcher({
      windowMs: 50,
      getBase: (convId) => base[convId] ?? [],
      apply: (updates) => {
        applied.push(new Map(updates))
        // 模拟 apply 后 state 与镜像同步
        for (const [convId, msgs] of updates) base[convId] = msgs
      },
    })
  })

  afterEach(() => {
    batcher.dispose()
    vi.useRealTimers()
  })

  it('窗口内同会话多次 update 链式生效，中间更新不丢失（回归：message.start + assistant_text + complete 同窗口）', () => {
    // message.start：占位消息
    batcher.update('conv-1', (list) => [...list, msg({ id: 'm4', content: '', status: 'streaming', seq: 3 })])
    // 同窗口 assistant_text：updater 读到的 base 必须包含 m4
    batcher.update('conv-1', (list) => {
      const target = list.find(m => m.id === 'm4')
      if (!target) throw new Error('m4 丢失——链式语义被破坏')
      return list.map(m => m.id === 'm4' ? { ...m, content: m.content + 'streaming...' } : m)
    })
    // 同窗口 message.complete
    batcher.update('conv-1', (list) => list.map(m => m.id === 'm4' ? { ...m, content: 'final', status: 'completed' as const } : m))

    vi.advanceTimersByTime(50)

    expect(applied).toHaveLength(1)
    const conv1 = applied[0].get('conv-1')!
    expect(conv1.map(m => m.id)).toEqual(['m1', 'm2', 'm4'])
    expect(conv1.find(m => m.id === 'm4')?.content).toBe('final')
    expect(conv1.find(m => m.id === 'm4')?.status).toBe('completed')
  })

  it('updater 同步执行：调用返回后即可读取闭包标志位（added 计数模式）', () => {
    let added = false
    batcher.update('conv-1', () => {
      added = true
      return [...base['conv-1'], msg({ id: 'm4' })]
    })
    expect(added).toBe(true)
  })

  it('updater 返回相同引用时不暂存、flush 无操作', () => {
    batcher.update('conv-1', (list) => list)
    vi.advanceTimersByTime(50)
    expect(applied).toHaveLength(0)
  })

  it('跨会话更新在同一窗口 flush 中各自生效', () => {
    batcher.update('conv-1', (list) => [...list, msg({ id: 'm4' })])
    batcher.update('conv-2', (list) => [...list, msg({ id: 'm5' })])
    vi.advanceTimersByTime(50)
    expect(applied).toHaveLength(1)
    expect(applied[0].has('conv-1')).toBe(true)
    expect(applied[0].has('conv-2')).toBe(true)
    expect(base['conv-1'].map(m => m.id)).toEqual(['m1', 'm2', 'm4'])
    expect(base['conv-2'].map(m => m.id)).toEqual(['m3', 'm5'])
  })

  it('窗口到期后新 update 开启新窗口；两次 flush 各自独立', () => {
    batcher.update('conv-1', (list) => [...list, msg({ id: 'm4' })])
    vi.advanceTimersByTime(50)
    batcher.update('conv-1', (list) => [...list, msg({ id: 'm5' })])
    vi.advanceTimersByTime(50)
    expect(applied).toHaveLength(2)
    expect(base['conv-1'].map(m => m.id)).toEqual(['m1', 'm2', 'm4', 'm5'])
  })

  it('flush 后再 update：base 是已应用的最新结果', () => {
    batcher.update('conv-1', (list) => [...list, msg({ id: 'm4' })])
    vi.advanceTimersByTime(50)
    batcher.update('conv-1', (list) => {
      expect(list.some(m => m.id === 'm4')).toBe(true)
      return list
    })
  })

  // —— 对抗审视二轮修复的回归用例：窗口内外部直接写入 state（双轨场景）——

  it('窗口内外部直接写入（上翻加载 prepend）不被 flush 覆盖——updater 链重放到最新列表', () => {
    // 场景：流式 assistant_text 追加文本（走 batcher）+ 同窗口用户上翻加载历史（直接写 state）
    batcher.update('conv-1', (list) =>
      list.map(m => m.id === 'm2' ? { ...m, content: m.content + ' 流式追加' } : m))
    // 外部直接写入：prepend 两条历史（不走 batcher，替换 base 引用）
    base['conv-1'] = [msg({ id: 'h1', content: '历史1' }), msg({ id: 'h2', content: '历史2' }), ...base['conv-1']]
    // 同窗口后续 batcher 更新
    batcher.update('conv-1', (list) =>
      list.map(m => m.id === 'm2' ? { ...m, content: m.content + '!' } : m))

    vi.advanceTimersByTime(50)

    // flush 结果必须同时含：prepend 的历史 + 重放后的流式追加
    expect(base['conv-1'].map(m => m.id)).toEqual(['h1', 'h2', 'm1', 'm2'])
    expect(base['conv-1'].find(m => m.id === 'h1')?.content).toBe('历史1')
    expect(base['conv-1'].find(m => m.id === 'm2')?.content).toBe('msg2 流式追加!')
  })

  it('窗口内外部直接写入（乐观置 aborted）不被 flush 回退', () => {
    batcher.update('conv-1', (list) =>
      list.map(m => m.id === 'm2' ? { ...m, content: m.content + ' 流式' } : m))
    // 外部直接写入：stopStream 乐观置 aborted（替换引用）
    base['conv-1'] = base['conv-1'].map(m => m.id === 'm2' ? { ...m, status: 'aborted' as const } : m)

    vi.advanceTimersByTime(50)

    const m2 = base['conv-1'].find(m => m.id === 'm2')
    expect(m2?.status).toBe('aborted')
    expect(m2?.content).toBe('msg2 流式')
  })

  it('窗口内无外部写入时直接应用暂存结果（不重放，staged 引用透传）', () => {
    const captured: LocalMessage[][] = []
    batcher = new MessageBatcher({
      windowMs: 50,
      getBase: (convId) => base[convId] ?? [],
      apply: (updates) => {
        for (const [convId, msgs] of updates) { captured.push(msgs); base[convId] = msgs }
      },
    })
    batcher.update('conv-1', (list) => [...list, msg({ id: 'm4' })])
    vi.advanceTimersByTime(50)
    expect(captured).toHaveLength(1)
    expect(captured[0].map(m => m.id)).toEqual(['m1', 'm2', 'm4'])
  })

  it('dispose 清理定时器，不再触发 apply（卸载后无泄漏 setState）', () => {
    batcher.update('conv-1', (list) => [...list, msg({ id: 'm4' })])
    batcher.dispose()
    vi.advanceTimersByTime(100)
    expect(applied).toHaveLength(0)
  })

  it('getBase 对未知会话返回空数组', () => {
    let seen: LocalMessage[] | undefined
    batcher.update('conv-new', (list) => {
      seen = list
      return list
    })
    expect(seen).toEqual([])
  })
})
