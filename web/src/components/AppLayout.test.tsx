// @vitest-environment jsdom
/**
 * F20260902imsc：IM 页滚动 + 双列布局回归测试。
 *
 * 背景：body overflow:hidden + h-screen 骨架下，IM 页忘写滚动容器，
 * 内容超出视口被裁且无滚动条（同类问题第三次现场：#503/#628 之后）。
 *
 * 覆盖：
 * 1. AppLayout 主内容区自带 overflow-y-auto 兜底 —— 新页面忘写滚动类不再导致内容被裁（骨架层防御）
 * 2. TopBar 不被滚动容器包裹——吸顶语义保持
 *
 * F20260920spa：AppLayout 改为 SPA 根布局（无 props，Outlet 渲染子路由）。
 * 测试用 MemoryRouter + Route 提供路由上下文。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// jsdom 无 window.matchMedia：QRCodeLoginCard / 组件内断点逻辑需要
beforeAll(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })))
})

vi.mock('../../api/client', () => ({
  getChannelStatus: vi.fn().mockResolvedValue({ channels: [] }),
  listWeixinAccounts: vi.fn().mockResolvedValue([]),
  listConnections: vi.fn().mockResolvedValue([]),
  getConnectionSession: vi.fn().mockResolvedValue(null),
  deleteWeixinAccount: vi.fn(),
  createConnection: vi.fn(),
  listActiveConversations: vi.fn().mockResolvedValue([]),
  enterConversation: vi.fn(),
  leaveConversation: vi.fn(),
}))

import { AppLayout } from './AppLayout'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
})

/** 包装 AppLayout + 路由上下文 + Outlet 子内容 */
function renderWithLayout(childContent: React.ReactNode) {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={childContent} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
  })
}

describe('AppLayout 骨架滚动兜底（F20260902imsc）', () => {
  it('主内容区自带 overflow-y-auto——子页面无需自声明即可滚动', async () => {
    renderWithLayout(<div>任意内容</div>)
    // 骨架防御：body overflow:hidden 裁剪之下，内容区必须有滚动容器
    // Why: 用 data-testid 而非 class 组合选择器 —— class 重构（如 h-screen→h-dvh）不应假阳性破坏行为断言（检视发现 1）
    const scrollable = document.querySelector('[data-testid="app-content-scroll"]')
    expect(scrollable).not.toBeNull()
  })

  it('TopBar 不被滚动容器包裹——吸顶语义保持', async () => {
    renderWithLayout(<div>任意内容</div>)
    const scrollable = document.querySelector('[data-testid="app-content-scroll"]')!
    expect(scrollable.querySelector('header')).toBeNull()
    expect(document.querySelector('header')).not.toBeNull()
  })
})

// Why: 布局契约的另一半 —— 滚动容器必须真带 overflow-y-auto（testid 只锚点，行为断言仍看 class）
// 避免 testid 加了但滚动类被误删的回归
it('滚动容器带 overflow-y-auto——testid 锚点不替代行为断言', async () => {
  renderWithLayout(<div>任意内容</div>)
  const scrollable = document.querySelector('[data-testid="app-content-scroll"]')! as HTMLElement
  expect(scrollable.className).toContain('overflow-y-auto')
})
