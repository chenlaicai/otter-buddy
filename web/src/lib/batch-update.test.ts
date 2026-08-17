import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MessageBatcher } from './batch-update'
import type { LocalMessage } from './mappers'

/**
 * F20260814qswp：直接测试真实实现 MessageBatcher。
 *
 * 测试基座（三轮）：mirror / queue 双轨——getBase 读 mirror（模拟 allMessagesRef，
 * 在 apply 后才同步，滞后于真实 state），apply 的 materialize 收到 queue（模拟
 * React setState 函数式 updater 的 prev，始终为队列最新值）。两轨的分离窗口
 * 用于表达真实组件里 commit→passive-effect 的镜像滞后间隙（二轮审视攻击面）。
 */

function msg(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id: 'm1', st: 'otter', si: 'otter-1', content: 'hello',
    status: 'completed', ts: '2026-07-24T00:00:00Z', dur: null,
    ...overrides,
  }
}

describe('MessageBatcher', () => {
  /** mirror：getBase 的数据源（滞后镜像，apply 后同步）；queue：materialize 收到的真实 state */
  let mirror: Record<string, LocalMessage[]>
  let queue: Record<string, LocalMessage[]>
  let appliedCount: number
  let batcher: MessageBatcher

  beforeEach(() => {
    vi.useFakeTimers()
    mirror = {
      'conv-1': [msg({ id: 'm1', content: 'msg1' }), msg({ id: 'm2', content: 'msg2' })],
      'conv-2': [msg({ id: 'm3', content: 'msg3' })],
    }
    queue = mirror
    appliedCount = 0
    batcher = new MessageBatcher({
      windowMs: 50,
      getBase: (convId) => mirror[convId] ?? [],
      apply: (updates) => {
        appliedCount++
        // 模拟 React setState(updater)：updater 读队列最新值 prev
        queue = { ...queue }
        for (const [convId, materialize] of updates) {
          queue[convId] = materialize(queue[convId])
        }
      },
    })
  })

  afterEach(() => {
    batcher.dispose()
    vi.useRealTimers()
  })

  /** 同步 mirror（模拟 passive effect：apply 之后、下一个 update 之前） */
  function syncMirror() {
    mirror = queue
  }

  it('窗口内同会话多次 update 链式生效，中间更新不丢失（回归：message.start + assistant_text + complete 同窗口）', () => {
    batcher.update('conv-1', (list) => [...list, msg({ id: 'm4', content: '', status: 'streaming', seq: 3 })])
    batcher.update('conv-1', (list) => {
      const target = list.find(m => m.id === 'm4')
      if (!target) throw new Error('m4 丢失——链式语义被破坏')
      return list.map(m => m.id === 'm4' ? { ...m, content: m.content + 'streaming...' } : m)
    })
    batcher.update('conv-1', (list) => list.map(m => m.id === 'm4' ? { ...m, content: 'final', status: 'completed' as const } : m))

    vi.advanceTimersByTime(50)

    expect(appliedCount).toBe(1)
    expect(queue['conv-1'].map(m => m.id)).toEqual(['m1', 'm2', 'm4'])
    expect(queue['conv-1'].find(m => m.id === 'm4')?.content).toBe('final')
    expect(queue['conv-1'].find(m => m.id === 'm4')?.status).toBe('completed')
  })

  it('updater 同步执行：调用返回后即可读取闭包标志位（added 计数模式）', () => {
    let added = false
    batcher.update('conv-1', () => {
      added = true
      return [...mirror['conv-1'], msg({ id: 'm4' })]
    })
    expect(added).toBe(true)
  })

  it('窗口内外部直接写入 queue（上翻加载 prepend）不被 flush 覆盖——updater 链重放', () => {
    batcher.update('conv-1', (list) =>
      list.map(m => m.id === 'm2' ? { ...m, content: m.content + ' 流式追加' } : m))
    // 外部直接写入 queue（不走 batcher，镜像尚未同步——模拟 commit 后 effect 前）
    queue = { ...queue, 'conv-1': [msg({ id: 'h1', content: '历史1' }), ...queue['conv-1']] }
    batcher.update('conv-1', (list) =>
      list.map(m => m.id === 'm2' ? { ...m, content: m.content + '!' } : m))

    vi.advanceTimersByTime(50)

    expect(queue['conv-1'].map(m => m.id)).toEqual(['h1', 'm1', 'm2'])
    expect(queue['conv-1'].find(m => m.id === 'h1')?.content).toBe('历史1')
    expect(queue['conv-1'].find(m => m.id === 'm2')?.content).toBe('msg2 流式追加!')
  })

  it('【三轮回归】镜像滞后间隙（外部写入 queue 但 mirror 未同步）不漏检——检测基于 queue 而非 mirror', () => {
    // 场景：二轮审视攻击面 2——flush 时 mirror 还是旧引用，但 queue 已含外部写入。
    // 修复后检测在 materialize(queue 值) 内做引用比较，mirror 滞后不再造成漏检。
    batcher.update('conv-1', (list) =>
      list.map(m => m.id === 'm2' ? { ...m, content: m.content + ' 流式' } : m))
    // 外部写入 queue，mirror 保持滞后
    queue = { ...queue, 'conv-1': queue['conv-1'].map(m => m.id === 'm2' ? { ...m, status: 'aborted' as const } : m) }

    vi.advanceTimersByTime(50)

    const m2 = queue['conv-1'].find(m => m.id === 'm2')
    expect(m2?.status).toBe('aborted')
    expect(m2?.content).toBe('msg2 流式')
  })

  it('【三轮回归】幂等 set 语义 updater 重放到"已含自身效果"的外部写入不重复', () => {
    // 场景：二轮审视攻击面 1——服务端 startSpeaking 已持久化全文，轮询快照替换 content；
    // 消费方（index.tsx liveText）用"累积 + 全量 set"，本用例验证该模式在重放下安全。
    const accumulated = { text: '' } // 模拟 liveText map
    const applyDelta = (delta: string) => {
      accumulated.text += delta
      const acc = accumulated.text
      batcher.update('conv-1', (list) =>
        list.map(m => m.id === 'm2' ? { ...m, content: acc } : m))
    }
    applyDelta('第一段')
    // 外部写入：轮询快照以服务端全文替换（已含"第一段"）
    queue = { ...queue, 'conv-1': queue['conv-1'].map(m => m.id === 'm2' ? { ...m, content: '第一段' } : m) }
    applyDelta('第二段')

    vi.advanceTimersByTime(50)

    // set 语义：最终为累积全文，无重复（+= 语义此处会得到"第一段第一段第二段"）
    expect(queue['conv-1'].find(m => m.id === 'm2')?.content).toBe('第一段第二段')
  })

  it('窗口内无外部写入时直接应用暂存结果', () => {
    batcher.update('conv-1', (list) => [...list, msg({ id: 'm4' })])
    vi.advanceTimersByTime(50)
    expect(queue['conv-1'].map(m => m.id)).toEqual(['m1', 'm2', 'm4'])
  })

  it('updater 返回相同引用（no-op）不留链：另一会话的 timer 触发 flush 时无该会话条目', () => {
    batcher.update('conv-1', (list) => list) // no-op，不应进 pending
    batcher.update('conv-2', (list) => [...list, msg({ id: 'm5' })]) // 起窗口
    vi.advanceTimersByTime(50)
    // conv-1 未被触碰（无条目、无空数组写入风险）
    expect(queue['conv-1'].map(m => m.id)).toEqual(['m1', 'm2'])
    expect(queue['conv-2'].map(m => m.id)).toEqual(['m3', 'm5'])
    expect(appliedCount).toBe(1)
  })

  it('窗口到期后新 update 开启新窗口；flush 后再 update 基于已应用结果', () => {
    batcher.update('conv-1', (list) => [...list, msg({ id: 'm4' })])
    vi.advanceTimersByTime(50)
    syncMirror() // 模拟 passive effect 同步镜像
    batcher.update('conv-1', (list) => {
      expect(list.some(m => m.id === 'm4')).toBe(true)
      return [...list, msg({ id: 'm5' })]
    })
    vi.advanceTimersByTime(50)
    expect(queue['conv-1'].map(m => m.id)).toEqual(['m1', 'm2', 'm4', 'm5'])
  })

  it('getBase 对未知会话返回空数组，materialize(current=undefined) 正常重放', () => {
    batcher.update('conv-new', (list) => [...list, msg({ id: 'n1' })])
    vi.advanceTimersByTime(50)
    expect(queue['conv-new'].map(m => m.id)).toEqual(['n1'])
  })

  it('dispose 清理定时器，不再触发 apply（卸载后无泄漏 setState）', () => {
    batcher.update('conv-1', (list) => [...list, msg({ id: 'm4' })])
    batcher.dispose()
    vi.advanceTimersByTime(100)
    expect(appliedCount).toBe(0)
  })
})
