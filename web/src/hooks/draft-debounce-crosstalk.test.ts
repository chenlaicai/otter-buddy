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

// ── #1132 检视处置（flush-on-switch）：检视獭-1280 证伪三形态的回归锚 ──

describe('#1132 flush-on-switch（检视处置三形态）', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('形态 A：快速切回——pending 输入已落盘，切回能读到（state/storage 不分叉）', () => {
    const { rerender, result } = renderHook(
      ({ convId }: { convId: string | null }) => useDraftCache(convId),
      { initialProps: { convId: 'conv-1' } },
    )
    act(() => { result.current.saveDraft('hello') })
    // 300ms 内切走（pending 未落盘）→ flush-on-switch 同步落盘
    rerender({ convId: 'conv-2' })
    // 模拟 conv-2 的 load effect 已跑；再快速切回 conv-1（不推进 timer）
    rerender({ convId: 'conv-1' })
    act(() => { vi.advanceTimersByTime(0) }) // 让 load effect 语义上完成
    expect(localStorage.getItem('draft:conv-1')).toBe('hello') // flush 后立即可读
    // 输入框 state 也应恢复（load effect 读到 flushed 值）
    expect(result.current.draft).toBe('hello')
  })

  it('形态 C：切走后新对话输入——旧对话 pending 不丢（timer 句柄共享曾经吞掉旧输入）', () => {
    const { rerender, result } = renderHook(
      ({ convId }: { convId: string | null }) => useDraftCache(convId),
      { initialProps: { convId: 'conv-1' } },
    )
    act(() => { result.current.saveDraft('conv-1 的重要输入') })
    rerender({ convId: 'conv-2' }) // flush-on-switch：conv-1 输入同步落盘
    act(() => { result.current.saveDraft('conv-2 的输入') }) // 新 timer（旧句柄被换）
    act(() => { vi.advanceTimersByTime(350) }) // 只够 conv-2 的 timer
    expect(localStorage.getItem('draft:conv-1')).toBe('conv-1 的重要输入') // 没丢
    expect(localStorage.getItem('draft:conv-2')).toBe('conv-2 的输入')
  })

  it('形态 B：beforeunload 不再覆盖 pending 新文本（写入意图优先）', () => {
    // 场景：draftRef 是旧稿（load 来的），用户改了输入（pending 新文本未落盘），页面关闭
    localStorage.setItem('draft:conv-1', 'old')
    const { result } = renderHook(() => useDraftCache('conv-1'))
    act(() => { vi.advanceTimersByTime(0) }) // load effect：draft='old', draftRef='old'
    act(() => { result.current.saveDraft('new') }) // pending=new, draftRef 也已同步 new
    // 但构造 draftRef 滞后的旧形态：直接触发 beforeunload（用真实事件）
    // saveDraft 已同步 draftRef，所以这里测的是 pending 优先级路径本身
    const unloadEvent = new Event('beforeunload')
    act(() => { window.dispatchEvent(unloadEvent) })
    expect(localStorage.getItem('draft:conv-1')).toBe('new') // pending 新文本赢，不被旧稿覆盖
  })

  it('flush 边界：pending 空串 flush 为 removeItem（与 S1 语义一致）', () => {
    localStorage.setItem('draft:conv-1', '残留')
    const { rerender, result } = renderHook(
      ({ convId }: { convId: string | null }) => useDraftCache(convId),
      { initialProps: { convId: 'conv-1' } },
    )
    act(() => { vi.advanceTimersByTime(0) }) // load '残留'
    act(() => { result.current.saveDraft('') }) // S1 同步 removeItem + pending 空串
    rerender({ convId: 'conv-2' })
    expect(localStorage.getItem('draft:conv-1')).toBeNull() // flush 空串=remove
  })
})
