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
/** F20260921inrl：列表/设置拉取计数——切换对话不应重拉（#1074 债务锚定） */
let listCalls = 0
let settingsCalls = 0
/** F20260923sswd：listInvokes 拉取计数——右栏状态恢复竞态/重试断言核心 */
let listInvokesCalls: string[] = []

function json(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200 })
}

function mockApi() {
  listEntriesCalls = []
  listCalls = 0
  settingsCalls = 0
  listInvokesCalls = []
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
    const invokesMatch = url.match(/^\/api\/conversations\/(conv-[ab])\/invokes/)
    if (invokesMatch) { listInvokesCalls.push(invokesMatch[1]!); return json({ invokes: [] }) }
    if (/^\/api\/conversations\/conv-[ab]\/key-resources/.test(url)) return json({ resources: [] })
    if (/^\/api\/conversations\/conv-[ab]\/read/.test(url)) return json({})
    // F20260921inrl S1（检视1076）：scheduled-tasks 必须返回数组——catch-all 的 json({})
    // 会让 useScheduledTasks.ts:20 的 res.map() 拋 TypeError（CI check FAIL 实证）。
    // convId 不限 conv-[ab]：深链接用例里 conv-gone 同样会触发该 hook。
    // （#1072 时代靠宽匹配误拿列表数组蒙混，mock 收窄后暴露）
    if (/^\/api\/conversations\/[^/]+\/(scheduled-tasks|attachments)/.test(url)) return json([])
    // 列表请求：带 query 的 /api/conversations?limit=…（子路径请求已在上面分流，这里只接列表本体）
    // F20260922cgrp：返回结构 { items, total }——列表本体与 LeftPanel 分组分页拉取共用此 mock；
    // listCalls 只计父组件首屏（limit=500，无 status），分组分页（status/kind）不计入「重拉」断言
    if (url.startsWith('/api/conversations?') || url === '/api/conversations') {
      const isGroupFetch = url.includes('status=') || url.includes('kind=')
      if (!isGroupFetch) listCalls++
      return json({ items: [convA, convB], total: 2 })
    }
    if (url.startsWith('/api/settings')) { settingsCalls++; return json({ userName: '测试用户' }) }
    // F20260921inrl D2（检视1076）：catch-all 返回 json({}) 是同类故障温床——未 mock 的
    // 端点拿到 {} 后 .map() 等数组操作直接 TypeError，且可能被 unhandled rejection 吞掉。
    // 改为显式警告 + 空对象：未知请求可见，漏 mock 时测试输出有明确线索。
    console.warn('[spa-nav-test] unmocked API call:', url)
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

describe('SPA 路由切换对话：初始加载不再重拉（F20260921inrl，#1074）', () => {
  it('切换对话不重拉对话列表与设置（mount 各一次）', async () => {
    mockApi()

    const router = createTestRouter('/conversation/conv-a')
    act(() => { root.render(<RouterProvider router={router} />) })
    await flushAsync()
    expect(listEntriesCalls).toEqual(['conv-a'])
    // mount 基线：列表与设置各拉一次
    expect(listCalls).toBe(1)
    expect(settingsCalls).toBe(1)

    // 切到 B：详情必须拉（F20260921spcm 语义），但列表/设置不得重拉
    await act(async () => { await router.navigate('/conversation/conv-b') })
    await flushAsync()
    expect(listEntriesCalls).toEqual(['conv-a', 'conv-b'])
    expect(listCalls).toBe(1)
    expect(settingsCalls).toBe(1)
    expect(container.textContent).toContain('B的第一条')
  })

  it('深链接指向不存在的对话：URL 替换为列表首个并正常渲染', async () => {
    mockApi()

    const router = createTestRouter('/conversation/conv-gone')
    act(() => { root.render(<RouterProvider router={router} />) })
    // 兑底 navigate 发生在 loadInitialData 完成后（异步链 + navigate 自身异步）——多等一轮
    await flushAsync()
    await flushAsync()

    // 列表返回不含 conv-gone → 兜底替换为列表首个 conv-a（URL 与内容一致，可刷新可分享）
    expect(router.state.location.pathname).toBe('/conversation/conv-a')
    expect(container.textContent).toContain('A的第一条')
    expect(listEntriesCalls).toEqual(['conv-a'])
  })
})

describe('右栏 invoke 状态恢复（F20260923sswd，issue #1134）', () => {
  it('listInvokes 与慢查询并行发出——不被 Promise.all 拖住（可控延迟断言调用顺序）', async () => {
    // 旧实现：listInvokes 排在 Promise.all 之后，慢 listEntries 会拖住它；
    // 新实现：并行发出——entries 挂起 200ms 期间，listInvokes 必须已经发出。
    vi.useFakeTimers()
    try {
      listInvokesCalls = []
      let entriesCalled = false
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        const invokesMatch = url.match(/^\/api\/conversations\/(conv-[ab])\/invokes/)
        if (invokesMatch) { listInvokesCalls.push(invokesMatch[1]!); return json({ invokes: [] }) }
        const entriesMatch = url.match(/^\/api\/conversations\/(conv-[ab])\/entries/)
        if (entriesMatch) {
          entriesCalled = true
          // 慢查询：挂起 200ms
          await new Promise(r => setTimeout(r, 200))
          return json({ hasMore: false, entries: entriesByConv[entriesMatch[1]!] })
        }
        if (/^\/api\/conversations\/conv-[ab]\/participants/.test(url)) return json([])
        if (/^\/api\/conversations\/conv-[ab]\/unread/.test(url)) return json({ lastReadSeq: 0, unreadCount: 0, firstUnreadMessageId: null, firstUnreadSeq: null })
        if (/^\/api\/conversations\/conv-[ab]\/key-resources/.test(url)) return json({ resources: [] })
        if (/^\/api\/conversations\/conv-[ab]\/read/.test(url)) return json({})
        if (/^\/api\/conversations\/[^/]+\/(scheduled-tasks|attachments)/.test(url)) return json([])
        if (url.startsWith('/api/conversations?') || url === '/api/conversations') return json({ items: [convA, convB], total: 2 })
        if (url.startsWith('/api/settings')) return json({ userName: '测试用户' })
        return json({})
      })
      const router = createTestRouter('/conversation/conv-b')
      await act(async () => { root.render(<RouterProvider router={router} />) })
      // 推进 50ms：entries 仍在挂起（200ms），但 listInvokes 必须已发出（并行）
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      expect(entriesCalled).toBe(true)
      expect(listInvokesCalls).toContain('conv-b')
      // 推进完 200ms：慢查询落地
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('listInvokes 失败 → 不静默吞，600ms/2500ms 两次延迟重试兜底（fake timers）', async () => {
    vi.useFakeTimers()
    try {
      let failCount = 3 // 初始 + 600ms 重试 + 2500ms 重试全败，验证兜底链完整触发
      listInvokesCalls = []
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        const invokesMatch = url.match(/^\/api\/conversations\/(conv-[ab])\/invokes/)
        if (invokesMatch) {
          listInvokesCalls.push(invokesMatch[1]!)
          if (failCount-- > 0) throw new Error('network down')
          return json({ invokes: [] })
        }
        const entriesMatch = url.match(/^\/api\/conversations\/(conv-[ab])\/entries/)
        if (entriesMatch) return json({ hasMore: false, entries: entriesByConv[entriesMatch[1]!] })
        if (/^\/api\/conversations\/conv-[ab]\/participants/.test(url)) return json([])
        if (/^\/api\/conversations\/conv-[ab]\/unread/.test(url)) return json({ lastReadSeq: 0, unreadCount: 0, firstUnreadMessageId: null, firstUnreadSeq: null })
        if (/^\/api\/conversations\/conv-[ab]\/key-resources/.test(url)) return json({ resources: [] })
        if (/^\/api\/conversations\/conv-[ab]\/read/.test(url)) return json({})
        if (/^\/api\/conversations\/[^/]+\/(scheduled-tasks|attachments)/.test(url)) return json([])
        if (url.startsWith('/api/conversations?') || url === '/api/conversations') return json({ items: [convA, convB], total: 2 })
        if (url.startsWith('/api/settings')) return json({ userName: '测试用户' })
        return json({})
      })
      const router = createTestRouter('/conversation/conv-a')
      await act(async () => { root.render(<RouterProvider router={router} />) })
      await act(async () => { await vi.advanceTimersByTimeAsync(60) })
      const callsAfterInitial = listInvokesCalls.length
      expect(callsAfterInitial).toBeGreaterThanOrEqual(1)
      // 推进 600ms → 第一次重试
      await act(async () => { await vi.advanceTimersByTimeAsync(700) })
      const callsAfter600 = listInvokesCalls.length
      expect(callsAfter600).toBeGreaterThan(callsAfterInitial)
      // 推进到 2500ms → 第二次重试（兜底链完整）
      await act(async () => { await vi.advanceTimersByTimeAsync(2200) })
      expect(listInvokesCalls.length).toBeGreaterThan(callsAfter600)
    } finally {
      vi.useRealTimers()
    }
  })
})
