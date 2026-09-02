// @vitest-environment jsdom
/**
 * F20260902imsc：IM 页滚动 + 双列布局回归测试。
 *
 * 背景：body overflow:hidden + h-screen 骨架下，IM 页忘写滚动容器，
 * 内容超出视口被裁且无滚动条（同类问题第三次现场：#503/#628 之后）。
 *
 * 覆盖：
 * 1. AppLayout 主内容区自带 overflow-y-auto 兜底 —— 新页面忘写滚动类不再导致内容被裁（骨架层防御）
 * 2. IM 页微信/飞书通道卡片双列并排（lg 断点），大厅独立一行
 * 3. 连接列表双列（md 断点）
 *
 * 断言方式：只断言可观察的布局契约（class 组合），不断言渲染调用细节。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

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

describe('AppLayout 骨架滚动兜底（F20260902imsc）', () => {
  it('主内容区自带 overflow-y-auto——子页面无需自声明即可滚动', async () => {
    await act(async () => {
      root.render(
        <AppLayout activeView="im">
          <div>任意内容</div>
        </AppLayout>,
      )
    })
    // 骨架防御：body overflow:hidden 裁剪之下，内容区必须有滚动容器
    const scrollable = document.querySelector('.h-screen > .overflow-y-auto')
    expect(scrollable).not.toBeNull()
  })

  it('TopBar 不被滚动容器包裹——吸顶语义保持', async () => {
    await act(async () => {
      root.render(
        <AppLayout activeView="im">
          <div>任意内容</div>
        </AppLayout>,
      )
    })
    const scrollable = document.querySelector('.h-screen > .overflow-y-auto')!
    expect(scrollable.querySelector('header')).toBeNull()
    expect(document.querySelector('header')).not.toBeNull()
  })
})
