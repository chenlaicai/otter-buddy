// @vitest-environment jsdom
/**
 * 记忆召回页面（F20260928mrui 重构，前称记忆搜索）测试：
 *
 * 1. #576 冒烟（保留）：初始态非空——最近记忆列表 / 显式空态文案 / 静默降级
 * 2. F20260928mrui：多条件查询面板渲染（内容类型多选/时间范围/对话过滤/高级开关）
 * 3. F20260928mrui：搜索请求携带新参数（content_type/created_after/expand_context/debug）
 * 4. F20260928mrui：结果结构化分组——doc 聚合（chunk 归拢）/ conversation 时间线 / 独立条目
 * 5. F20260928mrui：数据结构面板（showStructure 开关联动每条展开）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

document.body.innerHTML = '<div id="root"></div>'
const { default: MemorySearchPage } = await import('./index')

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

/** 初始请求（recent + health）+ 可选搜索结果的 fetch mock；返回捕获的搜索请求 URL 列表 */
function mockRoutes(searchBody?: unknown) {
  const searchUrls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/health/memory')) {
      return new Response(JSON.stringify({
        healthy: true, documentsOnDisk: 0, documentsInDb: 0,
        reconcileGaps: [], embeddingAvailable: true, embeddingModel: 'test',
      }), { status: 200 })
    }
    if (url.includes('/api/memory/recent')) {
      return new Response(JSON.stringify({ entries: [], total: 0 }), { status: 200 })
    }
    if (url.includes('/api/memory/search?')) {
      searchUrls.push(url + (init?.method === 'POST' ? ' [POST]' : ''))
      return new Response(JSON.stringify(searchBody ?? { entries: [], total: 0, vecCoverage: { total: 0, withVec: 0, ratio: 0 } }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
  return { searchUrls }
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

/** 触发一次搜索（输入关键词 + 点召回按钮） */
function doSearch(queryText: string) {
  const input = container.querySelector('input[placeholder*="关键词"]') as HTMLInputElement
  act(() => {
    // React 19 受控输入需走原生 setter 触发 onChange
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, queryText)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const btn = [...container.querySelectorAll('button')].find(b => b.textContent === '召回')
  act(() => { btn!.click() })
}

describe('记忆召回页面初始态冒烟（#576，保留）', () => {
  it('初始态有数据：展示最近记忆列表（非静默引导文案）', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/health/memory')) {
        return new Response(JSON.stringify({
          healthy: true, documentsOnDisk: 0, documentsInDb: 0,
          reconcileGaps: [], embeddingAvailable: true, embeddingModel: 'test',
        }), { status: 200 })
      }
      if (url.includes('/api/memory/recent')) {
        return new Response(JSON.stringify(RECENT_BODY), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    render()
    await act(async () => {})

    expect(container.textContent).toContain('最近记忆')
    expect(container.textContent).toContain('昨天讨论了页面空态问题')
  })

  it('初始态无数据：显式空态文案「暂无记忆数据」', async () => {
    mockRoutes()
    render()
    await act(async () => {})

    expect(container.textContent).toContain('暂无记忆数据')
  })

  it('recent 接口失败：静默降级（不崩、走空数据分支）', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/memory/recent')) throw new Error('network down')
      return new Response('{}', { status: 200 })
    })
    render()
    await act(async () => {})

    expect(container.textContent).toContain('暂无记忆数据')
  })
})

describe('多条件查询面板（F20260928mrui）', () => {
  it('渲染内容类型多选、时间范围、对话过滤与高级开关', async () => {
    mockRoutes()
    render()
    await act(async () => {})

    const text = container.textContent!
    expect(text).toContain('内容类型')
    expect(text).toContain('消息')
    expect(text).toContain('特性分段')
    expect(text).toContain('时间范围')
    expect(text).toContain('近 7 天')
    expect(text).toContain('对话过滤')
    expect(text).toContain('邻域扩展')
    expect(text).toContain('显示数据结构')
    expect(text).toContain('召回诊断')
  })

  it('搜索请求携带所选条件（content_type/created_after/expand_context/debug）', async () => {
    const { searchUrls } = mockRoutes()
    render()
    await act(async () => {})

    // 选两个内容类型 chip
    act(() => {
      ;[...container.querySelectorAll('button')].find(b => b.textContent === '消息')!.click()
    })
    act(() => {
      ;[...container.querySelectorAll('button')].find(b => b.textContent === '特性分段')!.click()
    })
    // 时间范围选近 7 天
    const timeSelect = [...container.querySelectorAll('select')].find(s => [...s.options].some(o => o.textContent === '近 7 天'))!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(timeSelect, '7d')
      timeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // 开三个高级开关
    for (const label of ['邻域扩展', '显示数据结构', '召回诊断']) {
      const cb = container.querySelector(`input[type="checkbox"]`)! // 三个 checkbox 逐个找
      const target = [...container.querySelectorAll('label')].find(l => l.textContent!.includes(label))!.querySelector('input')!
      void cb; void target
      act(() => { target.click() })
    }
    doSearch('记忆召回')
    await act(async () => {})

    expect(searchUrls).toHaveLength(1)
    const url = searchUrls[0]
    expect(url).toContain('query=')
    expect(url).toContain('content_type=message%2Cfeature_chunk')
    expect(url).toContain('created_after=')
    expect(url).toContain('expand_context=true')
    expect(url).toContain('debug=true')
  })

  it('默认搜索不带新参数（未选时保持原行为）', async () => {
    const { searchUrls } = mockRoutes()
    render()
    await act(async () => {})

    doSearch('关键词')
    await act(async () => {})

    expect(searchUrls[0]).not.toContain('content_type')
    expect(searchUrls[0]).not.toContain('created_after')
    expect(searchUrls[0]).not.toContain('expand_context')
    expect(searchUrls[0]).not.toContain('debug')
  })
})

describe('结果结构化分组（F20260928mrui 核心）', () => {
  const MIXED_RESULT = {
    total: 6,
    vecCoverage: { total: 6, withVec: 6, ratio: 1 },
    entries: [
      { id: 'm1', layer: 'historical', contentType: 'message', sourceId: 'msg-1', sourceTable: 'messages', conversationId: 'convA', granularity: 'fine', content: '消息一', metadata: null, createdAt: '2026-09-02T09:00:00Z', score: 0.9, source: 'both', snippet: '消息<b>一</b>' },
      { id: 'm2', layer: 'historical', contentType: 'message', sourceId: 'msg-2', sourceTable: 'messages', conversationId: 'convA', granularity: 'fine', content: '消息二', metadata: null, createdAt: '2026-09-03T10:00:00Z', score: 0.7, source: 'fts', snippet: '消息<b>二</b>' },
      { id: 'chunk1', layer: 'document', contentType: 'feature_chunk', sourceId: 'F20260928mrui', sourceTable: 'features', conversationId: null, granularity: 'fine', content: '分段一', metadata: { chunk_index: 1, doc_title: '记忆召回界面重构', heading_path: ['设计', '分组'] }, createdAt: '2026-09-20T00:00:00Z', score: 0.8, source: 'fts', snippet: '分段<b>一</b>' },
      { id: 'chunk0', layer: 'document', contentType: 'feature_chunk', sourceId: 'F20260928mrui', sourceTable: 'features', conversationId: null, granularity: 'fine', content: '分段零', metadata: { chunk_index: 0, doc_title: '记忆召回界面重构' }, createdAt: '2026-09-20T00:00:00Z', score: 0.6, source: 'fts', snippet: '分段<b>零</b>' },
      { id: 'fact1', layer: 'working', contentType: 'fact', sourceId: 'f-1', sourceTable: 'facts', conversationId: null, granularity: 'coarse', content: '事实条目', metadata: null, createdAt: '2026-09-10T00:00:00Z', score: 0.5, source: 'vec' },
    ],
    contextEntries: [
      { id: 'ctx0', layer: 'document', contentType: 'feature_chunk', sourceId: 'F20260928mrui', sourceTable: 'features', conversationId: null, granularity: 'fine', content: '邻域分段', metadata: { chunk_index: 2 }, createdAt: '2026-09-20T00:00:00Z', score: 0, source: 'context-expand' },
    ],
  }

  it('doc 命中按文档归组（chunk 归拢），conversation 命中聚合成时间线，fact 独立卡片', async () => {
    mockRoutes(MIXED_RESULT)
    render()
    await act(async () => {})

    doSearch('记忆')
    await act(async () => {})

    const text = container.textContent!
    // doc 组：标题 + 命中数（summary 无 + 2 chunk + 1 邻域 = 3 条命中）
    expect(text).toContain('记忆召回界面重构')
    const docCard = container.querySelector('[data-group-id="F20260928mrui"]')
    expect(docCard).toBeTruthy()
    expect(docCard!.textContent).toContain('3 条命中')
    expect(docCard!.querySelectorAll('[data-entry-id]')).toHaveLength(3)
    // doc 组内分段按 chunk_index 排序：分段零在前
    expect(docCard!.textContent!.indexOf('分段零')).toBeLessThan(docCard!.textContent!.indexOf('分段一'))

    // conversation 组
    const convCard = container.querySelector('[data-group-id="convA"]')
    expect(convCard).toBeTruthy()
    expect(convCard!.querySelectorAll('[data-entry-id]')).toHaveLength(2)

    // 独立 fact 卡片
    expect(container.querySelector('[data-entry-id="fact1"]')).toBeTruthy()

    // 汇总行：文档 1 · 对话 1 · 独立条目 1
    expect(container.querySelector('[data-testid="group-summary"]')!.textContent).toContain('文档 1')
    expect(container.querySelector('[data-testid="group-summary"]')!.textContent).toContain('对话 1')
    expect(container.querySelector('[data-testid="group-summary"]')!.textContent).toContain('独立条目 1')

    // 邻域标识存在
    expect(docCard!.textContent).toContain('邻域')
  })

  it('「显示数据结构」开启后每条展示完整数据面板（id/layer/score/来源）', async () => {
    mockRoutes(MIXED_RESULT)
    render()
    await act(async () => {})

    // 开启数据结构开关
    const target = [...container.querySelectorAll('label')].find(l => l.textContent!.includes('显示数据结构'))!.querySelector('input')!
    act(() => { target.click() })
    doSearch('记忆')
    await act(async () => {})

    const panels = container.querySelectorAll('[data-testid="entry-data-panel"]')
    expect(panels.length).toBeGreaterThanOrEqual(6) // 5 主结果 + 1 邻域
    const first = panels[0].textContent!
    expect(first).toContain('contentType:')
    expect(first).toContain('granularity:')
    expect(first).toContain('score:')
    expect(first).toContain('source:')
  })

  it('空结果：显示未找到相关记忆', async () => {
    mockRoutes({ entries: [], total: 0, vecCoverage: { total: 0, withVec: 0, ratio: 0 } })
    render()
    await act(async () => {})

    doSearch('不存在的词')
    await act(async () => {})

    expect(container.textContent).toContain('未找到相关记忆')
  })
})
