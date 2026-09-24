import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDraftCache } from './use-draft-cache'

describe('useDraftCache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('should load draft from localStorage when conversationId changes', () => {
    localStorage.setItem('draft:conv-1', 'saved draft')

    const { result, rerender } = renderHook(
      ({ conversationId }) => useDraftCache(conversationId),
      { initialProps: { conversationId: 'conv-1' } }
    )

    expect(result.current.draft).toBe('saved draft')

    rerender({ conversationId: 'conv-2' })
    expect(result.current.draft).toBe('')

    rerender({ conversationId: 'conv-1' })
    expect(result.current.draft).toBe('saved draft')
  })

  it('should not write to localStorage immediately on saveDraft (debounce)', () => {
    const { result } = renderHook(() => useDraftCache('conv-1'))

    act(() => {
      result.current.saveDraft('new draft')
    })

    // 状态立即更新
    expect(result.current.draft).toBe('new draft')
    // 但 localStorage 不应立即写入（debounce 300ms）
    expect(localStorage.getItem('draft:conv-1')).toBeNull()
  })

  it('should clear draft from localStorage when clearDraft is called', () => {
    localStorage.setItem('draft:conv-1', 'saved draft')

    const { result } = renderHook(() => useDraftCache('conv-1'))

    act(() => {
      result.current.clearDraft()
    })

    expect(result.current.draft).toBe('')
    expect(localStorage.getItem('draft:conv-1')).toBeNull()
  })

  it('should not save draft when conversationId is null', () => {
    const { result } = renderHook(() => useDraftCache(null))

    act(() => {
      result.current.saveDraft('new draft')
    })

    // conversationId 为 null 时不应写入任何 key
    expect(localStorage.getItem('draft:null')).toBeNull()
  })

  it('should save draft synchronously on beforeunload', () => {
    const { result } = renderHook(() => useDraftCache('conv-1'))

    act(() => {
      result.current.saveDraft('draft before unload')
    })

    act(() => {
      window.dispatchEvent(new Event('beforeunload'))
    })

    expect(localStorage.getItem('draft:conv-1')).toBe('draft before unload')
  })

  it('should update draft state immediately when saveDraft is called', () => {
    const { result } = renderHook(() => useDraftCache('conv-1'))

    act(() => {
      result.current.saveDraft('new draft')
    })

    expect(result.current.draft).toBe('new draft')
  })

  it('should clear draft state when conversationId becomes null', () => {
    const { result, rerender } = renderHook(
      ({ conversationId }) => useDraftCache(conversationId),
      { initialProps: { conversationId: 'conv-1' as string | null } }
    )

    act(() => {
      result.current.saveDraft('some text')
    })

    rerender({ conversationId: null })
    expect(result.current.draft).toBe('')
  })

  it('should restore different drafts for different conversations', () => {
    localStorage.setItem('draft:conv-1', 'draft A')
    localStorage.setItem('draft:conv-2', 'draft B')

    const { result, rerender } = renderHook(
      ({ conversationId }) => useDraftCache(conversationId),
      { initialProps: { conversationId: 'conv-1' } }
    )

    expect(result.current.draft).toBe('draft A')

    rerender({ conversationId: 'conv-2' })
    expect(result.current.draft).toBe('draft B')

    rerender({ conversationId: 'conv-1' })
    expect(result.current.draft).toBe('draft A')
  })

  it('should not resurrect manually cleared draft via debounce effect cleanup (ref sync timing)', () => {
    // Bug: saveDraft('x') 后 saveDraft('') 手动清空，debounce effect 的 cleanup 在
    // ref 同步 effect 之前执行，读到滞后的 draftRef.current='x' 并写回 localStorage，
    // 导致清空的内容在切换页面回来时复活。
    const { result, unmount } = renderHook(() => useDraftCache('conv-1'))

    // 第一笔草稿：写入 localStorage（模拟 debounce 完成的真实场景）
    act(() => {
      result.current.saveDraft('will-be-cleared')
    })
    act(() => {
      vi.advanceTimersByTime(400)  // debounce 触发，localStorage 写入
    })
    expect(localStorage.getItem('draft:conv-1')).toBe('will-be-cleared')

    // 手动清空：用户删光输入框内容
    act(() => {
      result.current.saveDraft('')
    })

    // 手动清空后 debounce timer 不写入（S1 修复：空串同步 removeItem 了）
    act(() => {
      vi.advanceTimersByTime(400)
    })

    // 卸载组件（模拟 SPA 导航离开）——cleanup 执行，但读到 draftRef.current='' 不写入
    unmount()

    // 关键断言：重新挂载后 draft 为空（不复活）
    const { result: result2 } = renderHook(() => useDraftCache('conv-1'))
    expect(result2.current.draft).toBe('')
  })

  it('should not resurrect when cleared and unmounted within debounce window (S1 CE-1)', () => {
    // S1 反例：清空后 300ms debounce 窗口内卸载（SPA 导航），旧 key 留存复活
    const { result, unmount } = renderHook(() => useDraftCache('conv-1'))

    // 写入草稿并完成 debounce
    act(() => {
      result.current.saveDraft('will-be-cleared')
    })
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(localStorage.getItem('draft:conv-1')).toBe('will-be-cleared')

    // 手动清空 + 立即卸载（300ms 窗口内，debounce timer 还未触发）
    act(() => {
      result.current.saveDraft('')
    })
    unmount()

    // 重新挂载：不应复活
    const { result: result2 } = renderHook(() => useDraftCache('conv-1'))
    expect(result2.current.draft).toBe('')
  })

  it('should not resurrect when cleared and beforeunload within debounce window (S1 CE-2)', () => {
    // S1 反例：清空后 300ms debounce 窗口内 beforeunload（关页/刷新），旧 key 留存复活
    const { result } = renderHook(() => useDraftCache('conv-1'))

    // 写入草稿并完成 debounce
    act(() => {
      result.current.saveDraft('will-be-cleared')
    })
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(localStorage.getItem('draft:conv-1')).toBe('will-be-cleared')

    // 手动清空
    act(() => {
      result.current.saveDraft('')
    })

    // 触发 beforeunload（300ms 窗口内，debounce timer 还未触发）
    act(() => {
      window.dispatchEvent(new Event('beforeunload'))
    })

    // 重新挂载：不应复活
    const { result: result2 } = renderHook(() => useDraftCache('conv-1'))
    expect(result2.current.draft).toBe('')
  })
})
