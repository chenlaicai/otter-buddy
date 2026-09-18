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

describe('LeftPanel 对话标题搜索（F20260916lpsc）', () => {
  const searchHit: LocalConversation = { id: 'c9', title: '工作区优化', status: 'active', otterIds: [], pinned: false }

  function mockSearchFetch(dtos: unknown[]) {
    return vi.fn().mockResolvedValue(
      new Response(JSON.stringify(dtos), { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
  }

  function dtoOf(c: LocalConversation) {
    return { id: c.id, title: c.title, status: c.status, pinned: c.pinned, otterIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
  }

  /** Why: React 受控 input 需走 native value setter + input 事件才能触发 onChange（React 16+ 值跟踪机制） */
  function typeKeyword(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('点击搜索按钮展开搜索框，不再跳转 /memory', () => {
    renderLeftPanel()
    // 旧行为是 <a href="/memory">——断言不存在该链接
    expect(container.querySelector('a[href="/memory"]')).toBeNull()

    const toggle = container.querySelector('[data-testid="leftpanel-search-toggle"]') as HTMLElement
    act(() => { toggle.click() })
    expect(container.querySelector('[data-testid="leftpanel-search-bar"]')).not.toBeNull()
  })

  it('输入关键字防抖后调 search API，列表替换为命中结果', async () => {
    vi.useFakeTimers()
    const mock = mockSearchFetch([dtoOf(searchHit)])
    vi.stubGlobal('fetch', mock)

    renderLeftPanel()
    act(() => { (container.querySelector('[data-testid="leftpanel-search-toggle"]') as HTMLElement).click() })

    const input = container.querySelector('[data-testid="leftpanel-search-bar"] input') as HTMLInputElement
    typeKeyword(input, '工作区')
    // 防抖 300ms 内不请求
    expect(mock).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(350) })

    expect(mock).toHaveBeenCalledTimes(1)
    expect(String(mock.mock.calls[0][0])).toContain('search=%E5%B7%A5%E4%BD%9C%E5%8C%BA')
    await vi.waitFor(() => {
      expect(container.textContent).toContain('工作区优化')
      expect(container.textContent).not.toContain('对话1')
    })
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('关闭搜索恢复父组件列表', async () => {
    vi.useFakeTimers()
    const mock = mockSearchFetch([dtoOf(searchHit)])
    vi.stubGlobal('fetch', mock)

    renderLeftPanel()
    act(() => { (container.querySelector('[data-testid="leftpanel-search-toggle"]') as HTMLElement).click() })
    const input = container.querySelector('[data-testid="leftpanel-search-bar"] input') as HTMLInputElement
    typeKeyword(input, '工作区')
    await act(async () => { vi.advanceTimersByTime(350) })
    await vi.waitFor(() => expect(container.textContent).toContain('工作区优化'))

    act(() => { (container.querySelector('[data-testid="leftpanel-search-close"]') as HTMLElement).click() })
    expect(container.querySelector('[data-testid="leftpanel-search-bar"]')).toBeNull()
    expect(container.textContent).toContain('对话1')
    expect(container.textContent).not.toContain('工作区优化')
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('搜索无命中时展示空态提示', async () => {
    vi.useFakeTimers()
    const mock = mockSearchFetch([])
    vi.stubGlobal('fetch', mock)

    renderLeftPanel()
    act(() => { (container.querySelector('[data-testid="leftpanel-search-toggle"]') as HTMLElement).click() })
    const input = container.querySelector('[data-testid="leftpanel-search-bar"] input') as HTMLInputElement
    typeKeyword(input, '不存在')
    await act(async () => { vi.advanceTimersByTime(350) })
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="leftpanel-search-empty"]')).not.toBeNull()
    })
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('Escape 关闭搜索框', () => {
    renderLeftPanel()
    act(() => { (container.querySelector('[data-testid="leftpanel-search-toggle"]') as HTMLElement).click() })
    const input = container.querySelector('[data-testid="leftpanel-search-bar"] input') as HTMLInputElement
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('[data-testid="leftpanel-search-bar"]')).toBeNull()
  })
})

describe('LeftPanel 分页加载更多（F20260916lpsc）', () => {
  it('hasMore + onLoadMore 时展示按钮并触发回调', () => {
    const onLoadMore = vi.fn()
    act(() => {
      root.render(
        <LeftPanel
          conversations={mockConversations}
          activeId="c1"
          onSelect={() => {}}
          onNewConversation={() => {}}
          onContextMenu={() => {}}
          otters={mockOtters}
          hasMore={true}
          loadingMore={false}
          onLoadMore={onLoadMore}
        />
      )
    })
    const btn = container.querySelector('[data-testid="leftpanel-load-more"]') as HTMLElement
    expect(btn).not.toBeNull()
    act(() => { btn.click() })
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('hasMore=false 时不展示加载更多按钮', () => {
    renderLeftPanel()
    expect(container.querySelector('[data-testid="leftpanel-load-more"]')).toBeNull()
  })
})

describe('LeftPanel IM 助理分组（F20260918imas）', () => {
  it('kind=assistant 的对话渲染在「IM 助理」分组内，普通对话不进该组', () => {
    const convs: LocalConversation[] = [
      { id: 'c1', title: '对话1', status: 'active', otterIds: [], pinned: false },
      { id: 'a1', title: '微信助理 · x12345', status: 'active', otterIds: [], pinned: false, kind: 'assistant' },
      { id: 'c2', title: '对话2', status: 'active', otterIds: [], pinned: true },
    ]
    act(() => {
      root.render(
        <LeftPanel
          conversations={convs}
          activeId="a1"
          onSelect={() => {}}
          onNewConversation={() => {}}
          onContextMenu={() => {}}
          otters={mockOtters}
        />
      )
    })
    // 分组标签存在
    const label = container.querySelector('[data-testid="leftpanel-assistant-group-label"]')
    expect(label?.textContent).toBe('IM 助理')
    // 助理项与普通项各归各组：按渲染顺序，a1 在 c2（置顶普通）之前。
    // ConversationItem 是 onClick onSelect 的 div，标题在内部 span
    const items = [...container.querySelectorAll('div.rounded-xl')].map(i => i.textContent ?? '')
    const a1Idx = items.findIndex(t => t.includes('微信助理'))
    const c2Idx = items.findIndex(t => t.includes('对话2'))
    expect(a1Idx).toBeGreaterThanOrEqual(0)
    expect(c2Idx).toBeGreaterThan(a1Idx)
  })

  it('无助理对话时不渲染分组标签', () => {
    renderLeftPanel()
    expect(container.querySelector('[data-testid="leftpanel-assistant-group-label"]')).toBeNull()
  })
})
