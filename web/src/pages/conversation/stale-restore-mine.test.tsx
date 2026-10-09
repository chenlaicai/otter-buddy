// @vitest-environment jsdom
/**
 * F20261008w8lt 确定性复现（jsdom 组件级）：陈旧 restore 地雷。
 *
 * 现象锚（alpha 实测帧序列，2026-10-08 v8 取证）：
 *   用户滚到顶触发 loadMore → loadMoreBefore 因 hasMoreBefore=false 早退（无新内容）
 *   → pendingScrollRestoreRef 已被武装但永不消费 → 用户滚回底部
 *   → 任意 messages.length 增长（新消息/聚焦刷新）→ W8 effect：
 *     scrollTop = 现 scrollHeight − 武装时记录的 scrollHeight = 任意中间位置
 *   → 视口从底部甩到中部 + 程序位移可能被归因（restore 紧 ε 匹配）——「自动上跳」。
 *
 * 本用例固化该序列，修复后应保持贴底（top=scrollHeight）不被甩出。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MessageList } from './MessageList'
import type { LocalMessage } from '../../lib/mappers'

let roInstances: unknown[] = []
class ROStub {
  cb: ResizeObserverCallback
  el: Element | null = null
  constructor(cb: ResizeObserverCallback) { this.cb = cb; roInstances.push(this) }
  observe(target: Element) { this.el = target }
  disconnect() {}
  unobserve() {}
}
const elementProto = Element.prototype as unknown as Record<string, unknown>
const hadScrollTo = Object.prototype.hasOwnProperty.call(elementProto, 'scrollTo')
beforeEach(() => {
  roInstances = []
  if (!hadScrollTo) elementProto.scrollTo = function () {}
  ;(globalThis as Record<string, unknown>).ResizeObserver = ROStub
})
afterEach(() => {
  if (!hadScrollTo) delete elementProto.scrollTo
  delete (globalThis as Record<string, unknown>).ResizeObserver
})
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function msg(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id: 'm1', st: 'otter', si: 'otter-1', sn: '大獭', content: '正文',
    status: 'completed', ts: '2026-08-14T00:00:00Z', dur: null, ...overrides,
  }
}
function instrumentRW(el: Element, scrollHeight: number, initialTop: number) {
  const state = { writes: 0, lastVal: -1, top: initialTop }
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 660 })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => state.top,
    set: (v: number) => { state.writes++; state.lastVal = v; state.top = v },
  })
  return state
}
function scrollerOf(): Element {
  for (const e2 of Array.from(document.querySelectorAll('.overflow-y-auto'))) {
    if (e2.querySelector('[data-message-id]')) return e2
  }
  throw new Error('消息滚动容器未找到')
}
function renderList(opts: { pinRef: { current: boolean }; messages?: LocalMessage[]; onLoadMore?: () => void }): { root: Root; div: HTMLDivElement } {
  const div = document.createElement('div')
  document.body.appendChild(div)
  const root = createRoot(div)
  act(() => {
    root.render(
      <MessageList
        messages={opts.messages ?? [msg()]}
        state="normal"
        onStopStream={() => {}}
        onRetryMessage={() => {}}
        onRetry={() => {}}
        onGoToSettings={() => {}}
        otters={[]}
        conversationId="c1"
        pinRef={opts.pinRef}
        onLoadMore={opts.onLoadMore}
      />,
    )
  })
  return { root, div }
}

describe('F20261008w8lt 陈旧 restore 地雷（复现+修复回归锚）', () => {
  it('武装后 loadMore 无内容 → 滚回底部 → 新消息到达：不应甩到中间', async () => {
    const pinRef = { current: true }
    let loadMoreCalls = 0
    const messages = Array.from({ length: 10 }, (_, i) => msg({ id: `m${i}`, ts: `2026-08-14T00:0${i}:00Z` }))
    const { root, div } = renderList({ pinRef, messages, onLoadMore: () => { loadMoreCalls++ } })
    try {
      await sleep(50)
      // 会话已全量加载（hasMoreBefore=false 语义）：loadMore 被调用但不会追加消息
      const st = instrumentRW(scrollerOf(), 3000, 0) // 初始贴底（mount pin 写 3000）
      st.top = 3000
      // ① 用户上翻到顶
      st.top = 0
      act(() => { scrollerOf().dispatchEvent(new Event('scroll')) })
      expect(loadMoreCalls).toBe(1) // 触发了 loadMore（但无内容加载——length 不变）
      // ② 用户滚回底部（看最新消息）
      st.top = 3000
      act(() => { scrollerOf().dispatchEvent(new Event('scroll')) })
      // ③ 新消息到达（SSE/聚焦刷新——length 增长）
      act(() => {
        root.render(
          <MessageList
            messages={[...messages, msg({ id: 'm-new', ts: '2026-08-14T00:10:00Z' })]}
            state="normal"
            onStopStream={() => {}}
            onRetryMessage={() => {}}
            onRetry={() => {}}
            onGoToSettings={() => {}}
            otters={[]}
            conversationId="c1"
            pinRef={pinRef}
            onLoadMore={() => {}}
          />,
        )
      })
      await sleep(30)
      // 修复前：W8 用陈旧记录（3000）做减法：scrollTop = 现 sh − 3000 → 甩到中间
      // （现 sh 仍 3000（jsdom 不重排），写入 = 0——用户从底部被甩到顶部）
      // 修复后：武装未消费/消费守卫——不应有任何非贴底写入
      const unexpectedWrite = st.writes > 0 && st.lastVal !== 3000
      expect(unexpectedWrite, `W8 陈旧 restore 写入了 top=${st.lastVal}（writes=${st.writes}）——地雷引爆`).toBe(false)
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
  })

  it('正常路径不回归：上翻到顶加载历史 → 仍贴顶 → 恢复写入「原距顶+新增量」', async () => {
    const pinRef = { current: true }
    const messages = Array.from({ length: 10 }, (_, i) => msg({ id: `m${i}`, ts: `2026-08-14T00:0${i}:00Z` }))
    let loadMoreCalls = 0
    const { root, div } = renderList({ pinRef, messages, onLoadMore: () => { loadMoreCalls++ } })
    try {
      await sleep(50)
      const st = instrumentRW(scrollerOf(), 3000, 3000)
      // 用户上翻到顶
      st.top = 0
      act(() => { scrollerOf().dispatchEvent(new Event('scroll')) })
      expect(loadMoreCalls).toBe(1)
      const writesBeforeHistory = st.writes // 基线：历史加载前的写入数（mount pin 等）
      // 历史加载（头部追加 5 条，仍贴顶——真实场景 scrollTop 仍是 0 附近）
      const older = Array.from({ length: 5 }, (_, i) => msg({ id: `old${i}`, ts: `2026-08-13T00:0${i}:00Z` }))
      act(() => {
        root.render(
          <MessageList
            messages={[...older, ...messages]}
            state="normal"
            onStopStream={() => {}}
            onRetryMessage={() => {}}
            onRetry={() => {}}
            onGoToSettings={() => {}}
            otters={[]}
            conversationId="c1"
            pinRef={pinRef}
            onLoadMore={() => {}}
          />,
        )
      })
      await sleep(30)
      // 恢复写入 = scrollTop(0) + pending(0) = 0：用户停留在原视觉位置（顶部历史起点）
      const restoreWrites = st.writes - writesBeforeHistory
      expect(restoreWrites).toBe(1)
      expect(st.lastVal).toBe(0)
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
  })
})
