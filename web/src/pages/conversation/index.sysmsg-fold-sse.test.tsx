// @vitest-environment jsdom
/**
 * F20261104ssfde SSE 端到端集成回归（检视发现 4 补全）：
 *   XHR SSE 帧（event: entry.system + data: {...senderName}）
 *   → index.tsx 订阅 handler 解析
 *   → LocalMessage（sn=scheduler:任务名）
 *   → MessageList 渲染折叠容器。
 * 此前没有用例驱动 handler 本身——组件级（sn → 折叠）与后端级（广播含 senderName）
 * 之间缺中段。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

document.body.innerHTML = '<div id="root"></div>'
const { default: ConversationPage } = await import('./index')

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

/** stub 的 XHR：测试侧往 responseText 塞 SSE 帧后手动触发 onprogress（仿 spa-nav BadgeXHR） */
class SSEStubXHR {
  static instances: SSEStubXHR[] = []
  responseText = ''
  onprogress: (() => void) | null = null
  onerror: (() => void) | null = null
  onload: (() => void) | null = null
  constructor() { SSEStubXHR.instances.push(this) }
  open() {}
  setRequestHeader() {}
  send() {}
  abort() {}
  tick(data: string) { this.responseText += data; this.onprogress?.() }
}

const conv = { id: 'conv-fold', title: '折叠SSE验证', status: 'active', pinned: false, lastMessagePreview: '', updatedAt: '2026-11-04T00:00:00Z' }

function json(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200 })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  SSEStubXHR.instances = []
  vi.stubGlobal('XMLHttpRequest', SSEStubXHR)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const method = (typeof input !== 'string' && (input as Request).method) || init?.method || 'GET'
    if (method === 'POST') return new Response(null, { status: 500 })
    if (url.includes('/entries')) return json({ hasMore: false, entries: [] })
    if (url.includes('/participants')) return json([])
    if (url.includes('/unread')) return json({ lastReadSeq: 0, unreadCount: 0, firstUnreadMessageId: null, firstUnreadSeq: null })
    if (url.includes('/invokes')) return json({ invokes: [] })
    if (url.includes('/key-resources')) return json({ resources: [] })
    if (url.includes('/scheduled-tasks') || url.includes('/attachments')) return json([])
    if (url.includes('/api/conversations/')) return json({})
    if (/^\/api\/otters\/[^/]+\/sessions/.test(url)) return json([])
    if (url.startsWith('/api/conversations?') || url === '/api/conversations') return json({ items: [conv], total: 1 })
    if (url.startsWith('/api/settings')) return json({ userName: '测试用户' })
    console.warn('[sysmsg-fold-sse-test] unmocked API call:', url)
    return json({})
  }))
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mountPage() {
  const router = createMemoryRouter([{ path: '/conversation/:id', element: <ConversationPage /> }], { initialEntries: ['/conversation/conv-fold'] })
  await act(async () => { root.render(<RouterProvider router={router} />) })
  await act(async () => { await new Promise(r => setTimeout(r, 300)) })
}

describe('F20261104ssfde：entry.system SSE 帧端到端（帧 → handler → sn → 折叠容器）', () => {
  it('scheduler 长消息帧 → 折叠容器渲染（含任务名，全文隐藏）', async () => {
    await mountPage()
    const xhr = SSEStubXHR.instances[0]
    expect(xhr, '订阅 effect 应已建立 XHR 连接').toBeTruthy()

    act(() => {
      xhr!.tick(`event: entry.system\ndata: ${JSON.stringify({
        entryId: 'sys-sse-1',
        content: '回顾昨日全部对话，按问题拆 GitHub issue。' + '检查维度。'.repeat(300),
        sequenceNum: 3,
        createdAt: '2026-11-04T00:30:00.000Z',
        senderName: 'scheduler:每日对话健康检查',
      })}\n\n`)
    })
    // MessageBatcher 50ms 合并窗口（BATCH_WINDOW_MS）——flush 后消息才落 state
    await act(async () => { await new Promise(r => setTimeout(r, 120)) })

    const fold = container.ownerDocument.querySelector('[data-testid="scheduler-sysmsg-fold"]')
    expect(fold, 'SSE 实时帧应渲染折叠容器').toBeTruthy()
    expect(fold!.textContent).toContain('每日对话健康检查')
    expect(fold!.textContent).not.toContain('检查维度')
  })

  it('无 senderName 的 system 帧（运行时提示类）→ 常规全文渲染，不折叠', async () => {
    await mountPage()
    const xhr = SSEStubXHR.instances[0]
    expect(xhr).toBeTruthy()

    act(() => {
      xhr!.tick(`event: entry.system\ndata: ${JSON.stringify({
        entryId: 'sys-sse-2',
        content: '运行时提示'.repeat(300),
        sequenceNum: 4,
        createdAt: '2026-11-04T00:31:00.000Z',
      })}\n\n`)
    })
    // 同上：等 MessageBatcher flush
    await act(async () => { await new Promise(r => setTimeout(r, 120)) })

    expect(container.ownerDocument.querySelector('[data-testid="scheduler-sysmsg-fold"]')).toBeNull()
    expect(container.textContent).toContain('运行时提示')
  })
})
