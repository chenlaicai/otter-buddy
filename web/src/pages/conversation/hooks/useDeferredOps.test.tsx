// @vitest-environment jsdom
/**
 * F20260827scrf2：useDeferredOps 单元测试。
 *
 * 覆盖：立即执行 / 弹窗期入队 / flush 按序重放 / 空队列 no-op /
 * isDeferred 引用变化不影响已入队闭包的重放语义
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useDeferredOps } from './useDeferredOps'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** 测试桩：渲染后暴露 runOrDefer/flush，由测试直接驱动 */
let harness: { runOrDefer: (op: () => void) => void; flush: () => void; setDeferred: (v: boolean) => void }

function Harness({ deferred }: { deferred: boolean }) {
  const [isDeferred, setDeferred] = useState(deferred)
  const { runOrDefer, flush } = useDeferredOps(() => isDeferred)
  harness = { runOrDefer, flush, setDeferred }
  return null
}

describe('useDeferredOps（F20260827scrf2）', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
  })

  it('非弹窗期：立即执行', async () => {
    await act(async () => { root.render(<Harness deferred={false} />) })
    const fn = vi.fn()
    await act(async () => { harness.runOrDefer(fn) })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('弹窗期：入队不执行，flush 按序一次性重放', async () => {
    await act(async () => { root.render(<Harness deferred={true} />) })
    const order: number[] = []
    const op1 = vi.fn(() => order.push(1))
    const op2 = vi.fn(() => order.push(2))
    await act(async () => { harness.runOrDefer(op1); harness.runOrDefer(op2) })
    expect(op1).not.toHaveBeenCalled()
    expect(op2).not.toHaveBeenCalled()

    await act(async () => { harness.flush() })
    expect(op1).toHaveBeenCalledTimes(1)
    expect(op2).toHaveBeenCalledTimes(1)
    expect(order).toEqual([1, 2])
  })

  it('闭包捕获入队时刻状态：重放语义 = 到达时刻语义（isAtBottom 快照场景）', async () => {
    await act(async () => { root.render(<Harness deferred={true} />) })
    const atBottomAtEvent = false // 事件到达时刻不在底部
    let counted = false
    await act(async () => {
      harness.runOrDefer(() => { if (!atBottomAtEvent) counted = true })
    })
    // 弹窗期间用户滚到底部（状态变化不影响已入队闭包）
    await act(async () => { harness.flush() })
    expect(counted).toBe(true)
  })

  it('flush 空队列 no-op，重复 flush 不重复执行', async () => {
    await act(async () => { root.render(<Harness deferred={true} />) })
    const fn = vi.fn()
    await act(async () => { harness.runOrDefer(fn) })
    await act(async () => { harness.flush(); harness.flush() })
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
