import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDraftCache } from './use-draft-cache'

describe('useDraftCache', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
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
})
