// @vitest-environment jsdom
/**
 * F20260921spcm 回归验证：SPA 路由切换对话时消息列表必须重新拉取。
 *
 * bug 现象（PR #1057 SPA 化引入）：左侧栏点进一个看过的对话，消息停留在旧缓存，
 * 海獭新发言不显示，需 F5 才恢复。
 * 根因：消息加载 useEffect 守门条件 `!allMessages[activeId]`——SPA 下组件不重挂载、
 * 缓存命中即跳过 fetch；SSE 只订阅当前对话且无历史回放，切走期间的事件永久丢失。
 *
 * 核心断言：同一组件实例下（模拟 /conversation/A → /conversation/B 的参数变化），
 * 切换 activeId 时 listEntries 必须再次调用（拉取最新数据），且以最新拉取结果渲染。
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

/** 两个对话的 fixture：B 的第二轮发言（entryB2）模拟「切走期间海獭新发言」 */
const convA: Record<string, unknown> = { id: 'conv-a', title: '对话A', status: 'active', pinned: false, lastMessagePreview: 'A消息', updatedAt: '2026-09-21T01:00:00Z' }
const convB: Record<string, unknown> = { id: 'conv-b', title: '对话B', status: 'active', pinned: false, lastMessagePreview: 'B消息', updatedAt: '2026-09-21T02:00:00Z' }

/** entries DTO（与后端 EntryDTO 对齐的最小字段） */
function entry(id: string, seq: number, body: string) {
  return { id, entryType: 'speak', senderType: 'otter', senderId: 'otter-1', senderName: '小獭', body, status: 'completed', sequenceNum: seq, createdAt: '2026-09-21T01:00:01Z', invokeId: 'inv-1' }
}

/** 服务端数据：B 的第二条（entryB2）模拟「切走期间海獭的新发言」 */
const entriesByConv: Record<string, unknown[]> = {
  'conv-a': [entry('entryA1', 1, 'A的第一条')],
  'conv-b': [entry('entryB1', 1, 'B的第一条'), entry('entryB2', 2, '切走期间海獭的新发言')],
}

/** listEntries 拉取计数——断言核心 */
let listEntriesCalls: string[] = []

function json(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200 })
}

function mockApi() {
  listEntriesCalls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    // entries 历史（before/after 游标分页不在本测试范围）
    const entriesMatch = url.match(/^\/api\/conversations\/(conv-[ab])\/entries/)
    if (entriesMatch) {
      listEntriesCalls.push(entriesMatch[1]!)
      return json({ hasMore: false, entries: entriesByConv[entriesMatch[1]] })
    }
    if (/^\/api\/conversations\/conv-[ab]\/participants/.test(url)) return json([])
    if (/^\/api\/conversations\/conv-[ab]\/unread/.test(url)) return json({ lastReadSeq: 0, unreadCount: 0, firstUnreadMessageId: null, firstUnreadSeq: null })
    if (/^\/api\/conversations\/conv-[ab]\/invokes/.test(url)) return json({ invokes: [] })
    if (/^\/api\/conversations\/conv-[ab]\/key-resources/.test(url)) return json({ resources: [] })
    if (/^\/api\/conversations\/conv-[ab]\/read/.test(url)) return json({})
    if (url.startsWith('/api/conversations')) return json([convA, convB])
    if (url.startsWith('/api/settings')) return json({ userName: '测试用户' })
    return json({})
  })
}

/** 数据路由：/conversation/:id 单一路由——参数变化不重挂载组件（SPA 行为，复刻 main.tsx） */
function createTestRouter(initialEntry: string) {
  return createMemoryRouter([
    { path: '/conversation/:id', element: <ConversationPage /> },
  ], { initialEntries: [initialEntry] })
}

/** 等 microtask 排空（loadInitialData / loadConversationDetail 均为异步链） */
async function flushAsync() {
  await act(async () => { await new Promise(r => setTimeout(r, 50)) })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  /** jsdom 的 Element.prototype.scrollTo 可能未实现——mount rAF 会调它，兜底 no-op（MessageList.test 同款） */
  const elementProto = (window as unknown as { Element: { prototype: Record<string, unknown> } }).Element.prototype
  if (typeof elementProto.scrollTo !== 'function') elementProto.scrollTo = () => {}
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
})

describe('SPA 路由切换对话：消息列表必须重新拉取（F20260921spcm）', () => {
  it('切回看过的对话时，listEntries 必须再次调用并渲染切走期间的新发言', async () => {
    mockApi()

    // 场景编排：A → B → 切回 A。A 已有缓存（bug 触发条件），服务端在用户切走期间给 A 加了新发言
    const router = createTestRouter('/conversation/conv-a')
    act(() => { root.render(<RouterProvider router={router} />) })
    await flushAsync()
    expect(listEntriesCalls).toEqual(['conv-a'])
    expect(container.textContent).toContain('A的第一条')

    // 切到 B（首次访问，正常拉取）
    await act(async () => { await router.navigate('/conversation/conv-b') })
    await flushAsync()
    expect(listEntriesCalls).toEqual(['conv-a', 'conv-b'])
    expect(container.textContent).toContain('B的第一条')

    // 模拟切走期间海獭在 A 发言：服务端给 A 追加新条目（前端无感知——SSE 只订 B）
    entriesByConv['conv-a'] = [entry('entryA1', 1, 'A的第一条'), entry('entryA2', 2, '切走期间海獭的新发言')]

    // 切回 A：bug 现场复现点——旧缓存命中，listEntries 被跳过，新发言不可见
    await act(async () => { await router.navigate('/conversation/conv-a') })
    await flushAsync()

    // 核心断言 1：切回 A 时再次调用了 listEntries（不是吃旧缓存）
    expect(listEntriesCalls).toEqual(['conv-a', 'conv-b', 'conv-a'])
    // 核心断言 2：切走期间的新发言渲染出来了
    expect(container.textContent).toContain('切走期间海獭的新发言')
  })
})
