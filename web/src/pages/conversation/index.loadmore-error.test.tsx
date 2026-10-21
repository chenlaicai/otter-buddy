// @vitest-environment jsdom
/**
 * issue #1581 验证：loadMoreBefore 加载历史失败必须有用户可见反馈 + 可用重试入口。
 *
 * bug 现象：catch 块静默（只 console.error），加载历史失败（网络断/服务端错/游标失效）时
 * 按钮/哨兵仍在、无报错、无重试提示——用户表现为「点加载更多没反应」。
 *
 * 核心断言：mock listEntries（before 游标请求）失败 → 页面出现用户可见的错误反馈元素
 * （按钮进入「加载失败，点击重试」错误态）；重试点击后恢复成功路径（历史 prepend）。
 * 修复前该断言必现静默（按钮纹丝不动），是本 bug 的失败证据用例。
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

const convA: Record<string, unknown> = { id: 'conv-a', title: '对话A', status: 'active', pinned: false, lastMessagePreview: 'A消息', updatedAt: '2026-10-21T01:00:00Z' }

function entry(id: string, seq: number, body: string) {
  return { id, entryType: 'speak', senderType: 'otter', senderId: 'otter-1', senderName: '小獭', body, status: 'completed', sequenceNum: seq, createdAt: '2026-10-21T01:00:01Z', invokeId: 'inv-1' }
}

/** before 游标请求的行为开关：true=500 失败（模拟服务端错），false=成功返回更早条目 */
let beforeShouldFail = true

function json(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200 })
}

function mockApi() {
  beforeShouldFail = true
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    const entriesMatch = url.match(/^\/api\/conversations\/(conv-a)\/entries/)
    if (entriesMatch) {
      if (url.includes('before=')) {
        if (beforeShouldFail) return new Response('internal error', { status: 500 })
        return json({ hasMore: false, entries: [entry('entryA0', 0, '更早的历史消息')] })
      }
      return json({ hasMore: true, entries: [entry('entryA1', 1, '首屏消息')] })
    }
    if (/^\/api\/conversations\/conv-a\/participants/.test(url)) return json([])
    if (/^\/api\/conversations\/conv-a\/unread/.test(url)) return json({ lastReadSeq: 0, unreadCount: 0, firstUnreadMessageId: null, firstUnreadSeq: null })
    if (/^\/api\/conversations\/conv-a\/invokes/.test(url)) return json({ invokes: [] })
    if (/^\/api\/conversations\/conv-a\/key-resources/.test(url)) return json({ resources: [] })
    if (/^\/api\/conversations\/conv-a\/read/.test(url)) return json({})
    if (/^\/api\/conversations\/[^/]+\/(scheduled-tasks|attachments)/.test(url)) return json([])
    if (url.startsWith('/api/conversations?') || url === '/api/conversations') return json({ items: [convA], total: 1 })
    if (url.startsWith('/api/settings')) return json({ userName: '测试用户' })
    console.warn('[loadmore-error-test] unmocked API call:', url)
    return json({})
  })
}

function createTestRouter(initialEntry: string) {
  return createMemoryRouter([
    { path: '/conversation/:id', element: <ConversationPage /> },
  ], { initialEntries: [initialEntry] })
}

async function flushAsync() {
  await act(async () => { await new Promise(r => setTimeout(r, 50)) })
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(b => b.textContent?.includes(label)) as HTMLButtonElement | undefined
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const elementProto = (window as unknown as { Element: { prototype: Record<string, unknown> } }).Element.prototype
  if (typeof elementProto.scrollTo !== 'function') elementProto.scrollTo = () => {}
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
})

describe('issue #1581 loadMoreBefore 失败态用户反馈', () => {
  it('mock listEntries（before 游标）失败 → 出现用户可见错误反馈元素（按钮错误态），重试可用', async () => {
    mockApi()
    const router = createTestRouter('/conversation/conv-a')
    act(() => { root.render(<RouterProvider router={router} />) })
    await flushAsync()
    expect(container.textContent).toContain('首屏消息')

    // 首屏 hasMore=true → 手动加载入口渲染
    const loadBtn = findButton('加载更早消息')
    expect(loadBtn, '首屏 hasMore=true 应渲染手动加载入口').toBeTruthy()

    // 触发一次失败的加载（before 游标请求 500）
    await act(async () => { loadBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flushAsync()

    // 核心断言（issue 验证断言）：失败后必须出现用户可见的错误反馈——按钮错误态
    const errBtn = findButton('加载失败')
    expect(errBtn, '加载失败后必须有用户可见的错误反馈（修复前此断言必现静默）').toBeTruthy()
    expect(errBtn!.textContent, '错误态文案必须含重试指引').toContain('重试')
    expect(errBtn!.disabled, '重试入口必须可点击').toBe(false)

    // 重试：恢复成功路径 → 历史 prepend，按钮退出错误态
    beforeShouldFail = false
    await act(async () => { errBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flushAsync()
    expect(container.textContent, '重试成功后更早历史应 prepend').toContain('更早的历史消息')
    expect(findButton('加载失败'), '重试成功后按钮退出错误态').toBeFalsy()
    // hasMore=false → 手动入口卸载（防假入口）
    expect(findButton('加载更早消息'), '历史拉完后入口卸载').toBeFalsy()
  })
})
