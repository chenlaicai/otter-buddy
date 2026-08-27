// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMediaQuery } from './use-media-query'

type ChangeHandler = (e: MediaQueryListEvent) => void

function mockMatchMedia(initial: boolean) {
  const listeners = new Set<ChangeHandler>()
  const mql = {
    matches: initial,
    media: '(min-width: 1024px)',
    addEventListener: (_: string, h: ChangeHandler) => listeners.add(h),
    removeEventListener: (_: string, h: ChangeHandler) => listeners.delete(h),
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  } as unknown as MediaQueryList
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql))
  return {
    mql,
    trigger(next: boolean) {
      act(() => {
        for (const h of listeners) h({ matches: next } as MediaQueryListEvent)
      })
    },
  }
}

describe('useMediaQuery（#500 响应式断点）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('初始返回 matchMedia 当前值（宽屏 true）', () => {
    mockMatchMedia(true)
    const { result } = renderHook(() => useMediaQuery('(min-width: 1024px)'))
    expect(result.current).toBe(true)
  })

  it('初始返回 matchMedia 当前值（窄屏 false）', () => {
    mockMatchMedia(false)
    const { result } = renderHook(() => useMediaQuery('(min-width: 1024px)'))
    expect(result.current).toBe(false)
  })

  it('跨断点 resize 时更新（true → false → true）', () => {
    const { trigger } = mockMatchMedia(true)
    const { result } = renderHook(() => useMediaQuery('(min-width: 1024px)'))
    expect(result.current).toBe(true)
    trigger(false)
    expect(result.current).toBe(false)
    trigger(true)
    expect(result.current).toBe(true)
  })

  it('卸载后移除监听（不再响应变化）', () => {
    const { trigger } = mockMatchMedia(true)
    const { result, unmount } = renderHook(() => useMediaQuery('(min-width: 1024px)'))
    unmount()
    trigger(false)
    expect(result.current).toBe(true)
  })

  it('无 matchMedia 环境（老浏览器/SSR 兜底）视为宽屏 true', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { result } = renderHook(() => useMediaQuery('(min-width: 1024px)'))
    expect(result.current).toBe(true)
  })
})
