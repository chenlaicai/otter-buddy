// @vitest-environment jsdom
/**
 * LeftPanel sessionStorage 滚动位置保持测试
 * - beforeunload 触发后 sessionStorage 被写入
 * - mount 后 scrollTop 被恢复
 * - 恢复后 sessionStorage 被清除
 * - 无效值不做恢复
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LeftPanel } from './LeftPanel'
import type { LocalConversation, LocalOtter } from '../../lib/mappers'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const SCROLL_POS_KEY = 'leftPanel:scrollTop'

let container: HTMLDivElement
let root: Root
let scrollToSpy: ReturnType<typeof vi.fn>

const mockConversations: LocalConversation[] = [
  { id: 'c1', title: '对话1', status: 'active', otterIds: [], pinned: false },
  { id: 'c2', title: '对话2', status: 'active', otterIds: [], pinned: false },
]
const mockOtters: LocalOtter[] = []

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  sessionStorage.clear()
  scrollToSpy = vi.fn()
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  sessionStorage.clear()
})

function getScrollContainer(): HTMLDivElement {
  const el = container.querySelector('.overflow-y-auto') as HTMLDivElement
  // jsdom 不实现 scrollTo，手动挂载 mock
  el.scrollTo = scrollToSpy as unknown as typeof el.scrollTo
  return el
}

function renderLeftPanel(onSelect: (id: string) => void = () => {}) {
  act(() => {
    root.render(
      <LeftPanel
        conversations={mockConversations}
        activeId="c1"
        onSelect={onSelect}
        onNewConversation={() => {}}
        onContextMenu={() => {}}
        otters={mockOtters}
      />
    )
  })
}

describe('LeftPanel sessionStorage 滚动位置保持', () => {
  it('beforeunload 触发后 sessionStorage 写入当前 scrollTop', () => {
    renderLeftPanel()
    const scrollContainer = getScrollContainer()
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 150, configurable: true })
    act(() => {
      window.dispatchEvent(new Event('beforeunload'))
    })
    expect(sessionStorage.getItem(SCROLL_POS_KEY)).toBe('150')
  })

  it('快速导航（mount 后立即 unmount）不导致异常', async () => {
    sessionStorage.setItem(SCROLL_POS_KEY, '200')
    renderLeftPanel()
    getScrollContainer()
    // 立即卸载，rAF 回调执行时组件已不在
    act(() => { root.unmount() })
    // rAF 回调仍会执行，但 optional chaining 保护不崩溃
    await vi.waitFor(() => {
      expect(sessionStorage.getItem(SCROLL_POS_KEY)).toBeNull()
    })
  })

  it('onSelect 回调正常触发，不被 beforeunload 逻辑影响', () => {
    const onSelect = vi.fn()
    renderLeftPanel(onSelect)
    const item = container.querySelector('[class*="cursor-pointer"]') as HTMLElement
    act(() => { item.click() })
    expect(onSelect).toHaveBeenCalledWith('c1')
    expect(sessionStorage.getItem(SCROLL_POS_KEY)).toBeNull()
  })

  it('组件卸载时移除 beforeunload 监听器', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    renderLeftPanel()
    act(() => { root.unmount() })
    expect(removeSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function))
    removeSpy.mockRestore()
  })

  it('mount 后从 sessionStorage 恢复滚动位置', async () => {
    sessionStorage.setItem(SCROLL_POS_KEY, '200')

    renderLeftPanel()
    getScrollContainer()

    await vi.waitFor(() => {
      expect(scrollToSpy).toHaveBeenCalledWith({ top: 200 })
      expect(sessionStorage.getItem(SCROLL_POS_KEY)).toBeNull()
    })
  })

  it('恢复后 sessionStorage 被清除，不影响后续刷新', async () => {
    sessionStorage.setItem(SCROLL_POS_KEY, '100')
    renderLeftPanel()
    getScrollContainer()

    await vi.waitFor(() => {
      expect(sessionStorage.getItem(SCROLL_POS_KEY)).toBeNull()
    })
  })

  it('sessionStorage 中为非数字时不做恢复，直接清除', async () => {
    sessionStorage.setItem(SCROLL_POS_KEY, 'not-a-number')

    renderLeftPanel()
    getScrollContainer()

    await vi.waitFor(() => {
      expect(scrollToSpy).not.toHaveBeenCalled()
      expect(sessionStorage.getItem(SCROLL_POS_KEY)).toBeNull()
    })
  })

  it('sessionStorage 为空时不影响正常挂载', () => {
    expect(sessionStorage.getItem(SCROLL_POS_KEY)).toBeNull()
    renderLeftPanel()
    const scrollContainer = container.querySelector('.overflow-y-auto')
    expect(scrollContainer).toBeTruthy()
  })
})
