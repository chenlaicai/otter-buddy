// @vitest-environment jsdom
/**
 * F20261006mtlp P1 只读 + F20261006mlp2 P2 交互层渲染/行为测试。
 *
 * P2 用例（板上按钮裁决 = 回执代执行通道 B，F20261006mlp2「按钮挂点架构定案」）：
 * - WAITING_PARTNER 条目渲染 批准/打回/否决 按钮组
 * - DONE_PENDING_CONFIRM 条目渲染 确认闭环/打回 按钮组
 * - 点「批准」→ 合成 html-matter-action 回执、经 onRouteToOtter 路由 owner（ownerOtterId）
 * - owner 为 null 的条目 → 路由 undefined mention（默认派发兜底）
 * - 「+」登记表单 → 提交合成登记回执（initialState=OPEN，准入路径 2）
 * - 近期闭环区（includeClosed 数据源）渲染 CLOSED 条目 + 翻案按钮
 *
 * jsdom 无后端：fetch mock 注入 matters 数据；onRouteToOtter spy 断言回执路由。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MattersPanel, type MatterRouteFn } from './MattersPanel'
import type { MatterDTO } from '../../api/client'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function matter(partial: Partial<MatterDTO> & { id: string }): MatterDTO {
  return {
    conversationId: 'c1',
    title: '事项',
    originMessageId: null,
    ownerOtterId: null,
    level: 'L2',
    state: 'OPEN',
    waitingOn: null,
    waitingFor: null,
    payload: null,
    resolution: null,
    resolvedBy: null,
    createdAt: '2026-10-06T00:00:00Z',
    updatedAt: '2026-10-06T00:00:00Z',
    closedAt: null,
    ...partial,
  }
}

/** mock fetch：listMatters 返回 open / 含 closed 两路数据 */
function mockFetchAll(open: MatterDTO[], all: MatterDTO[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const body = url.includes('includeClosed=1') ? all : open
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response
  }))
}

function renderPanel(onRoute?: MatterRouteFn) {
  act(() => {
    root.render(<MattersPanel conversationId="c1" onRouteToOtter={onRoute} />)
  })
}

/** 等一轮 effect（fetch resolve + setState） */
async function flush() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

function click(el: Element) {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
})

describe('MattersPanel P2 板上裁决（F20261006mlp2 回执代执行通道 B）', () => {
  it('WAITING_PARTNER 条目渲染 批准/打回/否决 按钮组', async () => {
    mockFetchAll(
      [matter({ id: 'aaaa1111-0000-4000-8000-000000000001', title: '配色拍板', state: 'WAITING_PARTNER', ownerOtterId: 'owner-1' })],
      [],
    )
    renderPanel()
    await flush()
    const actions = container.querySelector('[data-testid="matter-actions-wp"]')
    expect(actions).not.toBeNull()
    expect(actions!.textContent).toContain('批准')
    expect(actions!.textContent).toContain('打回')
    expect(actions!.textContent).toContain('否决')
  })

  it('DONE_PENDING_CONFIRM 条目渲染 确认闭环/打回 按钮组', async () => {
    mockFetchAll(
      [matter({ id: 'bbbb2222-0000-4000-8000-000000000002', title: '补丁收尾', state: 'DONE_PENDING_CONFIRM', ownerOtterId: 'owner-2' })],
      [],
    )
    renderPanel()
    await flush()
    const actions = container.querySelector('[data-testid="matter-actions-dpc"]')
    expect(actions).not.toBeNull()
    expect(actions!.textContent).toContain('确认闭环')
    expect(actions!.textContent).toContain('打回')
  })

  it('点「批准」→ 合成 html-matter-action 回执、路由 owner 獭', async () => {
    const m = matter({ id: 'cccc3333-0000-4000-8000-000000000003', title: '选型拍板', state: 'WAITING_PARTNER', ownerOtterId: 'owner-9' })
    mockFetchAll([m], [])
    const onRoute = vi.fn()
    renderPanel(onRoute)
    await flush()
    const approveBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === '批准')!
    click(approveBtn)
    expect(onRoute).toHaveBeenCalledTimes(1)
    const [body, ownerId] = onRoute.mock.calls[0]
    expect(ownerId).toBe('owner-9')
    expect(body).toContain('html-matter-action')
    expect(body).toContain('M-cccc3333')
    expect(body).toContain('to="DONE_PENDING_CONFIRM"')
    expect(body).toContain("on_behalf_of=\"partner\"")
  })

  it('点「否决」→ 回执目标态 ABANDONED（partner 专属「明确不做」）', async () => {
    const m = matter({ id: 'dddd4444-0000-4000-8000-000000000004', title: '废弃事项', state: 'WAITING_PARTNER', ownerOtterId: 'owner-9' })
    mockFetchAll([m], [])
    const onRoute = vi.fn()
    renderPanel(onRoute)
    await flush()
    const rejectBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === '否决')!
    click(rejectBtn)
    const [body] = onRoute.mock.calls[0]
    expect(body).toContain('to="ABANDONED"')
  })

  it('owner 为 null 的条目 → 路由 null（默认派发兜底，owner 已解散仍可操作）', async () => {
    const m = matter({ id: 'eeee5555-0000-4000-8000-000000000005', title: '无 owner 事项', state: 'WAITING_PARTNER', ownerOtterId: null })
    mockFetchAll([m], [])
    const onRoute = vi.fn()
    renderPanel(onRoute)
    await flush()
    const approveBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === '批准')!
    click(approveBtn)
    expect(onRoute).toHaveBeenCalledWith(expect.any(String), null)
  })

  it('「+」登记 → 提交合成登记回执（initialState=OPEN，准入路径 2，默认派发）', async () => {
    mockFetchAll([], [])
    const onRoute = vi.fn()
    renderPanel(onRoute)
    await flush()
    click(container.querySelector('[data-testid="matter-register-open"]')!)
    const input = container.querySelector('[data-testid="matter-register-input"]') as HTMLInputElement
    // React 受控组件：用 native setter + input 事件触发 onChange
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      nativeSetter.call(input, '回头再看的重构项')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const registerBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === '登记')!
    click(registerBtn)
    expect(onRoute).toHaveBeenCalledWith(expect.stringContaining('回头再看的重构项'), null)
    const [body] = onRoute.mock.calls[0]
    expect(body).toContain('initial_state="OPEN"')
    expect(body).toContain('html-matter-action')
  })

  it('近期闭环区渲染 CLOSED 条目 + 翻案按钮（includeClosed 数据源）', async () => {
    const closed = matter({ id: 'ffff6666-0000-4000-8000-000000000006', title: '已闭环事项', state: 'CLOSED', closedAt: '2026-10-06T01:00:00Z', resolution: '已处置' })
    mockFetchAll([], [closed])
    const onRoute = vi.fn()
    renderPanel(onRoute)
    await flush()
    click(container.querySelector('[data-testid="matter-closed-toggle"]')!)
    const closedItem = container.querySelector('[data-testid="matter-closed-item"]')
    expect(closedItem).not.toBeNull()
    expect(closedItem!.textContent).toContain('已闭环事项')
    const reopenBtn = Array.from(closedItem!.querySelectorAll('button')).find(b => b.textContent === '翻案')!
    click(reopenBtn)
    expect(onRoute).toHaveBeenCalledWith(expect.stringContaining('to="OPEN"'), null)
  })

  it('WAITING_PARTNER 条目渲染 payload 简报（F20261008mlp3 P3 严重2修复——板上简报呈现）', async () => {
    const m = matter({
      id: 'gggg7777-0000-4000-8000-000000000007',
      title: '方案拍板',
      state: 'WAITING_PARTNER',
      ownerOtterId: 'owner-1',
      payload: JSON.stringify({ brief: '方案 A：性能优先；方案 B：体验优先。推荐 A。' }),
    })
    mockFetchAll([m], [])
    renderPanel()
    await flush()
    const brief = container.querySelector('[data-testid="matter-brief"]')
    expect(brief).not.toBeNull()
    expect(brief!.textContent).toContain('方案 A：性能优先')
  })

  it('payload 为 null 的 WAITING_PARTNER 条目不渲染简报区', async () => {
    const m = matter({ id: 'hhhh8888-0000-4000-8000-000000000008', title: '无简报事项', state: 'WAITING_PARTNER', ownerOtterId: 'owner-1', payload: null })
    mockFetchAll([m], [])
    renderPanel()
    await flush()
    expect(container.querySelector('[data-testid="matter-brief"]')).toBeNull()
  })

  it('payload 非法 JSON 降级原文展示（不阻断面板渲染）', async () => {
    const m = matter({ id: 'iiii9999-0000-4000-8000-000000000009', title: '坏 payload', state: 'WAITING_PARTNER', ownerOtterId: 'owner-1', payload: 'not-json' })
    mockFetchAll([m], [])
    renderPanel()
    await flush()
    const brief = container.querySelector('[data-testid="matter-brief"]')
    expect(brief).not.toBeNull()
    expect(brief!.textContent).toContain('not-json')
  })

  it('OPEN 条目不渲染简报区（仅 WAITING_PARTNER 态呈现简报——§6 吸收语义）', async () => {
    const m = matter({ id: 'jjjj0000-0000-4000-8000-000000000010', title: 'OPEN 事项', state: 'OPEN', payload: JSON.stringify({ brief: '不该显示' }) })
    mockFetchAll([m], [])
    renderPanel()
    await flush()
    expect(container.querySelector('[data-testid="matter-brief"]')).toBeNull()
  })
})
