/**
 * #1132：debounce 回调闭包捕获 conversationId——300ms 窗口内切换对话不串写草稿。
 *
 * 场景回归锚（此前无覆盖）：conv-1 输入 → 300ms 内切到 conv-2 →
 * 旧代码（回调读 conversationIdRef.current）把 conv-1 的文本写进 draft:conv-2；
 * 新代码（闭包捕获）写进 draft:conv-1（text 与 id 配对）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDraftCache } from './use-draft-cache'

describe('#1132 debounce 回调闭包捕获 conversationId', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('300ms 窗口内切换对话：草稿写到输入发生时的对话（不串写新对话）', () => {
    const { rerender, result } = renderHook(
      ({ convId }: { convId: string | null }) => useDraftCache(convId),
      { initialProps: { convId: 'conv-1' } },
    )

    act(() => { result.current.saveDraft('conv-1 的文本') })
    // 300ms 窗口内切换对话（组件不卸载，conversationId prop 变化 → ref 已更新）
    rerender({ convId: 'conv-2' })
    // ref 同步 effect 跑完（React 在 rerender 后同步 effect）

    // debounce 到期
    act(() => { vi.advanceTimersByTime(350) })

    expect(localStorage.getItem('draft:conv-1')).toBe('conv-1 的文本') // 配对写入旧对话
    expect(localStorage.getItem('draft:conv-2')).toBeNull()             // 不串写新对话
  })

  it('不切换对话（正常路径）：草稿写到当前对话', () => {
    const { result } = renderHook(() => useDraftCache('conv-1'))
    act(() => { result.current.saveDraft('普通保存') })
    act(() => { vi.advanceTimersByTime(350) })
    expect(localStorage.getItem('draft:conv-1')).toBe('普通保存')
  })

  it('连续输入 debounce 合并：最后一次文本生效', () => {
    const { result } = renderHook(() => useDraftCache('conv-1'))
    act(() => { result.current.saveDraft('第一版') })
    act(() => { vi.advanceTimersByTime(200) })
    act(() => { result.current.saveDraft('第二版') })
    act(() => { vi.advanceTimersByTime(350) })
    expect(localStorage.getItem('draft:conv-1')).toBe('第二版')
  })
})
