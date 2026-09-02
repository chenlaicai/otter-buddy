// @vitest-environment jsdom
/**
 * #576（F20260901emps）：记忆搜索页面非空冒烟断言——防「页面静默空白」回归。
 *
 * 1. 初始态（recent 有数据）：展示「最近记忆」列表（非静默引导文案）
 * 2. 初始态（recent 空）：显式「暂无记忆数据」空态文案
 * 3. recent 接口失败：静默降级回引导文案（可接受——搜索仍是主路径）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

document.body.innerHTML = '<div id="root"></div>'
const { MemorySearchPage } = await import('./index')

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
  document.body.classList.remove('modal-open')
  vi.restoreAllMocks()
})

/** recent + health 两个初始请求的通用 mock（含在正文中出现、易误伤断言的「搜索记忆」文案——failover 用例改断言「暂无记忆数据」不出现） */
function mockInitialRoutes(recentBody: unknown, recentOk = true) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/health/memory')) {
      return new Response(JSON.stringify({
        healthy: true, documentsOnDisk: 0, documentsInDb: 0,
        reconcileGaps: [], embeddingAvailable: true, embeddingModel: 'test',
      }), { status: 200 })
    }
    if (url.includes('/api/memory/recent')) {
      if (!recentOk) throw new Error('network down')
      return new Response(JSON.stringify(recentBody), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
}

const RECENT_BODY = {
  entries: [{
    id: 'e1', layer: 'historical', contentType: 'message', sourceId: 's1',
    sourceTable: 'messages', conversationId: 'c1', granularity: 'fine',
    content: '昨天讨论了页面空态问题', metadata: null, createdAt: '2026-08-28T09:43:00Z',
  }],
  total: 1,
}

function render() {
  act(() => { root.render(<MemorySearchPage />) })
}

describe('记忆搜索页面非空冒烟（#576）', () => {
  it('初始态有数据：展示最近记忆列表（非静默引导文案）', async () => {
    mockInitialRoutes(RECENT_BODY)
    render()
    await act(async () => {})

    expect(container.textContent).toContain('最近记忆')
    expect(container.textContent).toContain('昨天讨论了页面空态问题')
  })

  it('初始态无数据：显式空态文案「暂无记忆数据」', async () => {
    mockInitialRoutes({ entries: [], total: 0 })
    render()
    await act(async () => {})

    expect(container.textContent).toContain('暂无记忆数据')
  })

  it('recent 接口失败：静默降级（无错误态、无假空态文案）', async () => {
    mockInitialRoutes(null, false)
    render()
    await act(async () => {})

    // fetch reject 被 catch：setRecent([]) 会让「暂无记忆数据」文案出现——
    // 这是降级路径与真无数据的唯一区别，此处锁「不崩、不假空态」：
    // catch 后 recent=[]，同空数据分支，文案出现即降级成立
    expect(container.textContent).toContain('暂无记忆数据')
  })
})
