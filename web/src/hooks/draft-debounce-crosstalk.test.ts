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

  it('形态 B：切走+新输入+关页面——两对话草稿都不丢不覆盖', () => {
    // delta Δ2 改造：原构造（同对话 saveDraft 后直接 beforeunload）下 pending 与
    // draftRef 恒等（saveDraft 同步两者），旧实现也绿——恒真锚。改为可区分构造：
    // 切走+新输入+关页面。旧实现（1e8e055d）下 beforeunload 清掉 timer 后只写
    // 当前对话，conv-1 未落盘输入永久丢失；新实现 flush-on-switch 已保住 conv-1。
    const { rerender, result } = renderHook(
      ({ convId }: { convId: string | null }) => useDraftCache(convId),
      { initialProps: { convId: 'conv-1' } },
    )
    act(() => { result.current.saveDraft('conv-1 未落盘的输入') })
    rerender({ convId: 'conv-2' }) // flush：conv-1 同步落盘
    act(() => { result.current.saveDraft('conv-2 的新输入') }) // conv-2 pending
    act(() => { window.dispatchEvent(new Event('beforeunload')) }) // 300ms 内关页面
    expect(localStorage.getItem('draft:conv-1')).toBe('conv-1 未落盘的输入') // 不丢
    expect(localStorage.getItem('draft:conv-2')).toBe('conv-2 的新输入')      // 不覆盖
  })

  it('形态 D（Δ1 fix-regression）：窗口内清空输入——切换/beforeunload 不复活已删草稿', () => {
    // delta Δ2 改造：原「flush 空串边界」锚的是 S1 同步 removeItem（flush 的
    // else 分支不可达——saveDraft('') 在 Δ1 前已 return，pending 恒非空）。
    // 改为锚 Δ1 本体：saveDraft('x') 后 300ms 窗口内清空，pendingWriteRef 必须被清掉，
    // 否则残留 {conv-1,'x'} 被三条路径写回复活。
    const { rerender, result } = renderHook(
      ({ convId }: { convId: string | null }) => useDraftCache(convId),
      { initialProps: { convId: 'conv-1' } },
    )
    act(() => { result.current.saveDraft('x') }) // pending={conv-1,'x'}，timer 未 fire
    act(() => { result.current.saveDraft('') })  // S1 同步 removeItem；Δ1：清 pending
    // 路径 1：切换对话 flush——修复前 pending 残留 'x' 写回复活
    rerender({ convId: 'conv-2' })
    expect(localStorage.getItem('draft:conv-1')).toBeNull() // 不复活
    // 路径 2：beforeunload pending 优先——修复前同样写回 'x'
    act(() => { window.dispatchEvent(new Event('beforeunload')) })
    expect(localStorage.getItem('draft:conv-1')).toBeNull() // 不复活
  })
})
