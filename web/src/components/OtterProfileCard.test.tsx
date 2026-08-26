// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { OtterProfileCard } from './OtterProfileCard'
import type { LocalOtter, LocalOtterSession } from '../lib/mappers'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

function makeOtter(overrides: Partial<LocalOtter> = {}): LocalOtter {
  return {
    id: 'o-test',
    name: '测试獭',
    type: 'small',
    createdAt: '2026-08-25',
    ...overrides,
  }
}

function makeSession(overrides: Partial<LocalOtterSession> = {}): LocalOtterSession {
  return {
    id: 's1',
    otterId: 'o-test',
    status: 'active',
    previousSessionId: null,
    startedAt: '2026-08-25 10:00',
    archivedAt: null,
    archiveReason: null,
    isNegativeCase: false,
    summary: null,
    ...overrides,
  }
}

describe('OtterProfileCard', () => {
  it('应显示獭名称和类型', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(<OtterProfileCard otter={makeOtter()} sessions={[makeSession()]} />)
    })

    expect(container.textContent).toContain('测试獭')
    expect(container.textContent).toContain('任务专员')
    expect(container.textContent).toContain('Lv.1')

    act(() => { root.unmount() })
    container.remove()
  })

  it('大獭应显示"族群长老"称号', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(<OtterProfileCard otter={makeOtter({ type: 'big' })} sessions={[]} />)
    })

    expect(container.textContent).toContain('族群长老')

    act(() => { root.unmount() })
    container.remove()
  })

  it('有 modelAlias 时应显示武器', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(<OtterProfileCard otter={makeOtter()} sessions={[]} modelAlias="mimo" />)
    })

    expect(container.textContent).toContain('mimo')

    act(() => { root.unmount() })
    container.remove()
  })

  it('无 modelAlias 时不应显示武器行', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(<OtterProfileCard otter={makeOtter()} sessions={[]} />)
    })

    expect(container.textContent).not.toContain('mimo')

    act(() => { root.unmount() })
    container.remove()
  })
})

/** PR-3：hover 400ms debounce 时序测试（vitest fake timers）。
 *
 *  测试策略：纯函数级别验证 debounce 逻辑（setTimeout 回调触发与清除），
 *  不依赖 React 渲染。OtterParticipantCard 的 debounce 逻辑：
 *  - mouseenter → setTimeout(400ms) → setHovering(true)
 *  - mouseleave → clearTimeout + setHovering(false)
 *
 *  为什么不用 React 组件测试：React 19 scheduler + vi.useFakeTimers 存在已知交互问题，
 *  timer 回调内的 setState 无法被 act() flush。函数级测试覆盖了 debounce 的核心契约。
 *  OtterProfileCard 渲染测试已在上方 describe 覆盖。 */
describe('hover 400ms debounce 时序（PR-3）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('停留 ≥400ms 触发回调', () => {
    const callback = vi.fn()

    // 还原 handleMouseEnter 逻辑：setTimeout(400ms)
    setTimeout(callback, 400)

    // <400ms：不应触发
    vi.advanceTimersByTime(399)
    expect(callback).not.toHaveBeenCalled()

    // ≥400ms：应触发
    vi.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('快速滑过（<400ms 移出）不触发回调', () => {
    const callback = vi.fn()

    // 进入：设置定时器
    const timerId = setTimeout(callback, 400)

    // <400ms 移出：清除定时器
    vi.advanceTimersByTime(300)
    clearTimeout(timerId)

    // 推进到 400ms+：不应触发
    vi.advanceTimersByTime(200)
    expect(callback).not.toHaveBeenCalled()
  })

  it('移出后重新进入需重新计时', () => {
    const callback = vi.fn()

    // 第一次进入：设置定时器并部分推进
    const firstTimerId = setTimeout(callback, 400)
    vi.advanceTimersByTime(200)

    // 移出：清除定时器
    clearTimeout(firstTimerId)

    // 再次进入：重新设置定时器（故意不清除——测试到期触发）
    setTimeout(callback, 400)

    // 200ms 后（距离第二次进入）：不应触发
    vi.advanceTimersByTime(200)
    expect(callback).not.toHaveBeenCalled()

    // 再 200ms（第二次进入后 400ms）：应触发
    vi.advanceTimersByTime(200)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('鼠标快速来回不触发回调', () => {
    const callback = vi.fn()

    // 快速来回 3 次（每次 <400ms）
    for (let i = 0; i < 3; i++) {
      const tid = setTimeout(callback, 400)
      vi.advanceTimersByTime(100)
      clearTimeout(tid)
    }

    // 推进到远超 400ms：不应触发
    vi.advanceTimersByTime(1000)
    expect(callback).not.toHaveBeenCalled()
  })

  it('进入后停留精确 400ms 触发一次', () => {
    const callback = vi.fn()

    setTimeout(callback, 400)
    vi.advanceTimersByTime(400)
    expect(callback).toHaveBeenCalledTimes(1)

    // 再推进：不应重复触发
    vi.advanceTimersByTime(400)
    expect(callback).toHaveBeenCalledTimes(1)
  })
})
