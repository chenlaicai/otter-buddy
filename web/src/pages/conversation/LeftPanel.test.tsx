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
import * as api from '../../api/client'

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

function dtoOf(c: LocalConversation) {
  return { id: c.id, title: c.title, status: c.status, pinned: c.pinned, otterIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...(c.kind === 'assistant' ? { kind: 'assistant' } : {}) }
}

/** F20260922cgrp：LeftPanel 普通/已归档分组自拉分页数据——默认 stub 空页（total=0），
 *  各用例需要具体数据时显式调用本函数覆盖 */
// F20260922cgrp delta（检视严重 1）：普通区拉取恒带 pinned:false——total/items 均不含置顶，
// stub 语义 = 「非置顶普通对话」（与生产口径一致，不再固化「total 含置顶」的错误假设）
function stubGroupFetch(normalItems: unknown[] = [], normalTotal = 0, archivedItems: unknown[] = [], archivedTotal = 0) {
  return vi.spyOn(api, 'listConversations').mockImplementation((options) => {
    if (options?.search) return Promise.resolve({ items: [], total: 0 }) as never
    if (options?.status === 'archived') return Promise.resolve({ items: archivedItems, total: archivedTotal }) as never
    return Promise.resolve({ items: normalItems, total: normalTotal }) as never
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  sessionStorage.clear()
  localStorage.clear()
  scrollToSpy = vi.fn()
  stubGroupFetch()
})

afterEach(() => {
  vi.restoreAllMocks()
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

  it('onSelect 回调正常触发，不被 beforeunload 逻辑影响', async () => {
    const onSelect = vi.fn()
    // F20260922cgrp：普通对话由 LeftPanel 内部分页拉取（异步）——显式 stub 提供 c1
    stubGroupFetch([dtoOf(mockConversations[0])], 1)
    renderLeftPanel(onSelect)
    const item = await vi.waitFor(() => {
      const el = container.querySelector('[class*="cursor-pointer"]') as HTMLElement | null
      expect(el).not.toBeNull()
      return el!
    })
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

  function mockSearchFetch(dtos: unknown[], groupDtos: unknown[] = []) {
    // F20260922cgrp：listConversations 返回 { items, total }；
    // 分组分页拉取（无 search 参数）与搜索请求按 URL 区分返回
    return vi.fn().mockImplementation((url: unknown) => {
      const isSearch = String(url).includes('search=')
      const payload = isSearch ? { items: dtos, total: dtos.length } : { items: groupDtos, total: groupDtos.length }
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
      )
    })
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
    vi.restoreAllMocks() // 撤掉 beforeEach 的分组 stub——fetch stub 接管全部请求
    const mock = mockSearchFetch([dtoOf(searchHit)])
    vi.stubGlobal('fetch', mock)

    renderLeftPanel()
    act(() => { (container.querySelector('[data-testid="leftpanel-search-toggle"]') as HTMLElement).click() })

    const input = container.querySelector('[data-testid="leftpanel-search-bar"] input') as HTMLInputElement
    typeKeyword(input, '工作区')
    // 防抖 300ms 内不发搜索请求（F20260922cgrp：mount 时的分组拉取不计——断言带 search 参数的请求）
    expect(mock.mock.calls.filter(c => String(c[0]).includes('search='))).toHaveLength(0)
    await act(async () => { vi.advanceTimersByTime(350) })

    const searchCalls = mock.mock.calls.filter(c => String(c[0]).includes('search='))
    expect(searchCalls).toHaveLength(1)
    expect(String(searchCalls[0][0])).toContain('search=%E5%B7%A5%E4%BD%9C%E5%8C%BA')
    await vi.waitFor(() => {
      expect(container.textContent).toContain('工作区优化')
      expect(container.textContent).not.toContain('对话1')
    })
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('关闭搜索恢复父组件列表', async () => {
    vi.useFakeTimers()
    vi.restoreAllMocks()
    const mock = mockSearchFetch([dtoOf(searchHit)], [dtoOf(mockConversations[0])])
    vi.stubGlobal('fetch', mock)

    renderLeftPanel()
    act(() => { (container.querySelector('[data-testid="leftpanel-search-toggle"]') as HTMLElement).click() })
    const input = container.querySelector('[data-testid="leftpanel-search-bar"] input') as HTMLInputElement
    typeKeyword(input, '工作区')
    await act(async () => { vi.advanceTimersByTime(350) })
    await vi.waitFor(() => expect(container.textContent).toContain('工作区优化'))

    act(() => { (container.querySelector('[data-testid="leftpanel-search-close"]') as HTMLElement).click() })
    expect(container.querySelector('[data-testid="leftpanel-search-bar"]')).toBeNull()
    // F20260922cgrp：恢复分组视图后普通对话由内部分页拉取（异步渲染）
    await vi.waitFor(() => expect(container.textContent).toContain('对话1'))
    expect(container.textContent).not.toContain('工作区优化')
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('搜索无命中时展示空态提示', async () => {
    vi.useFakeTimers()
    vi.restoreAllMocks()
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

describe('LeftPanel 三分组 + 分页跳转（F20260922cgrp）', () => {
  it('三分组头渲染：IM 助理 / 对话 / 已归档，默认 助理开、对话开、归档关', async () => {
    renderLeftPanel()
    expect(container.querySelector('[data-testid="leftpanel-group-assistant"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="leftpanel-group-conversation"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="leftpanel-group-archived"]')).not.toBeNull()
    // 已归档默认折叠——分页器与列表项不可见
    expect(container.querySelector('[data-testid="leftpanel-pagination-archived"]')).toBeNull()
    // 「加载更多」机制退役
    expect(container.querySelector('[data-testid="leftpanel-load-more"]')).toBeNull()
  })

  it('折叠状态持久化 localStorage，重新挂载后保持', async () => {
    stubGroupFetch([dtoOf(mockConversations[0])], 1)
    renderLeftPanel()
    // 等待初始分页拉取渲染普通项
    await vi.waitFor(() => expect(container.textContent).toContain('对话1'))
    // 折叠「对话」组
    act(() => { (container.querySelector('[data-testid="leftpanel-group-conversation"]') as HTMLElement).click() })
    expect(localStorage.getItem('leftPanel:collapsed:conversation')).toBe('1')
    // 普通对话项不可见（组头标题恒在——断言列表项元素消失而非文本）
    expect(container.querySelector('.cursor-pointer')).toBeNull()
    // 展开「已归档」组
    act(() => { (container.querySelector('[data-testid="leftpanel-group-archived"]') as HTMLElement).click() })
    expect(localStorage.getItem('leftpanel:collapsed:archived') ?? localStorage.getItem('leftPanel:collapsed:archived')).toBe('0')
    act(() => { root.unmount() })
    container.remove()
    // 重新挂载：折叠态保持
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    renderLeftPanel()
    expect(container.querySelector('.cursor-pointer')).toBeNull()
    // 归档组展开后空态可见
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="leftpanel-archived-empty"]')).not.toBeNull()
    })
  })

  it('普通对话分页：total>20 时渲染页码跳转器，点击页码拉对应页', async () => {
    const page1Items = Array.from({ length: 20 }, (_, i) => dtoOf({ id: `n${i + 1}`, title: `普通${i + 1}`, status: 'active', otterIds: [], pinned: false }))
    const spy = stubGroupFetch(page1Items, 45)
    renderLeftPanel()
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="leftpanel-pagination-conversation"]')).not.toBeNull()
    })
    // 45 total / 20 一页 = 3 页
    expect(container.querySelector('[data-testid="leftpanel-pagination-conversation-page-3"]')).not.toBeNull()
    // 点第 2 页
    spy.mockClear()
    act(() => { (container.querySelector('[data-testid="leftpanel-pagination-conversation-page-2"]') as HTMLElement).click() })
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalled()
      const call = spy.mock.calls.find(c => (c[0] as { offset?: number })?.offset === 20)
      expect(call).toBeTruthy()
      // F20260922cgrp delta：普通区拉取带 pinned:false（排除置顶，计数口径对齐）
      expect((call![0] as { pinned?: boolean }).pinned).toBe(false)
    })
  })

  it('页数收缩 clamp：末页条目清空后回退到新末页（防空白页死锁，检视严重 2）', async () => {
    // 初始 45 条 = 3 页；跳到第 3 页后 total 收缩为 20（1 页）→ 重拉回空页 → clamp 回 1
    let total = 45
    const page3Items = Array.from({ length: 5 }, (_, i) => dtoOf({ id: `n${41 + i}`, title: `普通${41 + i}`, status: 'active', otterIds: [], pinned: false }))
    const spy = vi.spyOn(api, 'listConversations').mockImplementation((options) => {
      if (options?.status === 'archived') return Promise.resolve({ items: [], total: 0 }) as never
      const offset = options?.offset ?? 0
      // total 收缩后 offset=40 的页返回空（模拟末页 5 条全部被归档）
      const items = total === 45
        ? Array.from({ length: 20 }, (_, i) => dtoOf({ id: `n${offset + i + 1}`, title: `普通${offset + i + 1}`, status: 'active', otterIds: [], pinned: false }))
        : []
      return Promise.resolve({ items, total }) as never
    })
    void page3Items
    renderLeftPanel()
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="leftpanel-pagination-conversation-page-3"]')).not.toBeNull()
    })
    act(() => { (container.querySelector('[data-testid="leftpanel-pagination-conversation-page-3"]') as HTMLElement).click() })
    await vi.waitFor(() => {
      expect(spy.mock.calls.some(c => (c[0] as { offset?: number })?.offset === 40)).toBe(true)
    })
    // total 收缩为 20 → clamp 回第 1 页并重拉
    total = 20
    // 触发重拉：conversations prop 变化（模拟归档操作后父组件刷新）
    act(() => {
      root.render(
        <LeftPanel
          conversations={[...mockConversations]}
          activeId="c1"
          onSelect={() => {}}
          onNewConversation={() => {}}
          onContextMenu={() => {}}
          otters={mockOtters}
        />
      )
    })
    await vi.waitFor(() => {
      // clamp 后重新拉第 1 页（offset=0），分页器存活（不消失 = 不死锁）
      expect(spy.mock.calls.filter(c => (c[0] as { offset?: number })?.offset === 0).length).toBeGreaterThan(1)
    })
  })

  it('total ≤ 20 时不渲染分页器', async () => {
    renderLeftPanel()
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="leftpanel-group-conversation"]')).not.toBeNull()
    })
    expect(container.querySelector('[data-testid="leftpanel-pagination-conversation"]')).toBeNull()
  })

  it('置顶项渲染区分底色（pinnedHighlight）且组头计数 = 置顶数 + 普通 total', async () => {
    const convs: LocalConversation[] = [
      { id: 'p1', title: '置顶对话', status: 'active', otterIds: [], pinned: true },
      { id: 'a1', title: '微信助理 · x1', status: 'active', otterIds: [], pinned: false, kind: 'assistant' },
    ]
    stubGroupFetch([dtoOf({ id: 'n1', title: '普通1', status: 'active', otterIds: [], pinned: false })], 7)
    act(() => {
      root.render(
        <LeftPanel
          conversations={convs}
          activeId=""
          onSelect={() => {}}
          onNewConversation={() => {}}
          onContextMenu={() => {}}
          otters={mockOtters}
        />
      )
    })
    // 置顶项渲染区分底色 + 计数等分页拉取完成后断言（异步）
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="conv-item-pinned-p1"]')).not.toBeNull()
      // 「对话」组头计数 = 1（置顶） + 7（普通 total）
      expect(container.querySelector('[data-testid="leftpanel-group-conversation-count"]')?.textContent).toBe('8')
    })
    // 「IM 助理」组头计数 = 1
    expect(container.querySelector('[data-testid="leftpanel-group-assistant-count"]')?.textContent).toBe('1')
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
    // 分组标签存在（F20260922cgrp：组头改为可折叠 GroupHeader）
    const label = container.querySelector('[data-testid="leftpanel-group-assistant"]')
    // F20260920imax rebase 后分组标签含计数徽章（textContent = "IM 助理" + 数量）——
    // 断言改为包含匹配，避免徽章计数变化脆断
    expect(label?.textContent).toContain('IM 助理')
    // 助理项与普通项各归各组：按渲染顺序，a1 在 c2（置顶普通）之前。
    // ConversationItem 是 onClick onSelect 的 div，标题在内部 span
    const items = [...container.querySelectorAll('div.rounded-xl')].map(i => i.textContent ?? '')
    const a1Idx = items.findIndex(t => t.includes('微信助理'))
    const c2Idx = items.findIndex(t => t.includes('对话2'))
    expect(a1Idx).toBeGreaterThanOrEqual(0)
    expect(c2Idx).toBeGreaterThan(a1Idx)
    // 普通（非置顶）对话 c1 不进「对话」组的父组件数据源视图——由内部分页拉取呈现
  })

  it('无助理对话时分组头仍在（计数 0）——F20260922cgrp：三分组恒渲染，可折叠', () => {
    renderLeftPanel()
    const label = container.querySelector('[data-testid="leftpanel-group-assistant"]')
    expect(label).not.toBeNull()
    expect(container.querySelector('[data-testid="leftpanel-group-assistant-count"]')?.textContent).toBe('0')
  })

  it('置顶的助理对话仍留在 IM 助理分组内（不升入普通置顶组）', async () => {
    // F20260922cgrp：普通对话由内部分页拉取——stub 提供（c1 非置顶，从父组件 props 隔离）
    stubGroupFetch([dtoOf({ id: 'c1', title: '普通对话', status: 'active', otterIds: [], pinned: false })], 1)
    const convs: LocalConversation[] = [
      { id: 'a1', title: '微信助理 · x1', status: 'active', otterIds: [], pinned: true, kind: 'assistant' },
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
    // 助理项（虽 pinned）仍在助理组
    const items = [...container.querySelectorAll('div.rounded-xl')].map(i => i.textContent ?? '')
    const a1Idx = items.findIndex(t => t.includes('微信助理'))
    expect(a1Idx).toBeGreaterThanOrEqual(0)
    // 置顶的普通项经内部分页拉取渲染后，位于助理项之后（「对话」组在「IM 助理」组下方）
    await vi.waitFor(() => {
      const all = [...container.querySelectorAll('div.rounded-xl')].map(i => i.textContent ?? '')
      expect(all.findIndex(t => t.includes('普通对话'))).toBeGreaterThan(a1Idx)
    })
    // 普通对话归入「对话」组（置顶区），助理组标签也存在（两组共存）
    expect(container.querySelector('[data-testid="leftpanel-group-assistant"]')?.textContent).toContain('IM 助理')
  })

  it('搜索态平铺渲染命中结果（F20260922cgrp：不分组不分页，既有搜索行为保留）', async () => {
    // LeftPanel 内部搜索走 api.listConversations({search})，mock client 返回混合结果
    const spy = vi.spyOn(api, 'listConversations').mockImplementation((options) => {
      if (options?.search) {
        return Promise.resolve({
          items: [
            { id: 'a1', title: '微信助理 · x1', status: 'active', pinned: false, otterIds: [], kind: 'assistant' },
            { id: 'c1', title: '普通对话', status: 'active', pinned: false, otterIds: [] },
          ],
          total: 2,
        }) as never
      }
      return Promise.resolve({ items: [], total: 0 }) as never
    })
    renderLeftPanel()
    const toggle = container.querySelector('[data-testid="leftpanel-search-toggle"]') as HTMLElement
    act(() => { toggle.click() })
    const input = container.querySelector('input[placeholder*="搜索"]') as HTMLInputElement
    act(() => {
      // 触发 debounced 搜索（300ms）——用原生 setter 确 React onChange 生效
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '对话')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await new Promise(r => setTimeout(r, 400))
    expect(spy).toHaveBeenCalled()
    // 搜索态平铺：分组头不渲染
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="leftpanel-group-assistant"]')).toBeNull()
    })
    const items = [...container.querySelectorAll('div.rounded-xl')].map(i => i.textContent ?? '')
    expect(items.findIndex(t => t.includes('微信助理'))).toBeGreaterThanOrEqual(0)
    spy.mockRestore()
  })
})
