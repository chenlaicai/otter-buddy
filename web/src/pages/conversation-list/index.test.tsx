// @vitest-environment jsdom
/**
 * 对话列表右键菜单 Portal 化测试（F20261023pmnu，#1006）。
 *
 * 覆盖：
 * 1. 菜单经 createPortal 挂 document.body（脱离根容器 containing block 风险域）——
 *    有牙断言：document 查到 + container 查不到，旧实现（组件树内 fixed 渲染）下必红
 * 2. Portal 后交互不回退：点击菜单项仍调 pin API 并收起菜单
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ConversationListPage from './index'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// 轮询 hook 空实现：本测试只关心菜单挂载点与点击交互，不测轮询
vi.mock('../../hooks/use-conversation-list-polling', () => ({
  useConversationListPolling: () => {},
}))

const navigateMock = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams(''), vi.fn()],
}))

const CONV_LIST = {
  items: [{ id: 'c1', title: '测试对话', status: 'active', pinned: false }],
  total: 1,
}

let fetchMock: ReturnType<typeof vi.fn>

function makeFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((url: string) => {
    if (typeof url === 'string' && url.includes('/pin')) {
      return Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
    }
    return Promise.resolve(
      new Response(JSON.stringify(CONV_LIST), { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
  })
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  fetchMock = makeFetch()
  vi.stubGlobal('fetch', fetchMock)
  navigateMock.mockClear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function renderAndOpenMenu() {
  await act(async () => { root.render(<ConversationListPage />) })
  // ConversationItem 根 div 无稳定 testid（仅 pinned 时有）——按标题文本定位，contextmenu 冒泡到挂 handler 的祖先
  const span = Array.from(container.querySelectorAll('span')).find(s => s.textContent === '测试对话')
  expect(span).not.toBeNull()
  await act(async () => {
    span!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 200 }))
  })
}

describe('对话列表右键菜单 Portal 化（F20261023pmnu）', () => {
  it('菜单经 createPortal 挂 document.body，不渲染在页面容器内', async () => {
    await renderAndOpenMenu()

    // 菜单挂 document.body（脱离根容器未来 transform/backdrop-filter 的 containing block 风险域），断言查 document
    const menu = document.querySelector('[data-testid="convlist-ctx-menu"]')
    expect(menu).not.toBeNull()
    expect(menu!.textContent).toContain('置顶')
    // 有牙回归断言：菜单不应渲染在页面容器内（防退回 fixed-in-container，旧实现下此断言必红）
    expect(container.querySelector('[data-testid="convlist-ctx-menu"]')).toBeNull()
  })

  it('Portal 后点击菜单项仍工作：置顶项调 pin API 并收起菜单', async () => {
    await renderAndOpenMenu()

    const menuItem = document.querySelector('[data-testid="convlist-ctx-menu"] > div') as HTMLDivElement
    await act(async () => { menuItem.click() })

    const pinCall = fetchMock.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && String(c[0]).includes('/pin')
    ) as [string, RequestInit?] | undefined
    expect(pinCall).toBeDefined()
    expect(pinCall![1]?.method).toBe('PATCH')
    // 点击后菜单收起
    expect(document.querySelector('[data-testid="convlist-ctx-menu"]')).toBeNull()
  })
})
