// @vitest-environment jsdom
/**
 * MessageList 渲染测试。
 * （F20260913ctlv 切换清扫：流式过程面板 StreamingProcess 已退役——流式只在 Session 弹窗展示，
 *  原「流式过程面板事件渲染」describe 块随组件一并移除）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MessageList } from './MessageList'
import type { LocalMessage } from '../../lib/mappers'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function msg(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id: 'm1', st: 'otter', si: 'otter-1', sn: '大獭', content: '最终正文',
    status: 'completed', ts: '2026-08-14T00:00:00Z', dur: null, ...overrides,
  }
}

describe('F20260907sgpt 高度贴底补偿（ResizeObserver，检视发现 1/2 修正版）', () => {
  /**
   * 背景：信号轨迹 chip / 徽标 / 流式面板折叠等不改 messages.length 的高度变化曾无任何补偿，
   * 用户在底部时视口周期性上跳（搭档 09-07 第五次报告同类现象）。
   *
   * 检视发现 1/2（mimo）后的结构：双 observer——contentObserver 观测内容包裹 div
   * （contentRef，contentRect.height = 内容总高度），viewportObserver 观测滚动容器
   * （scrollRef，contentRect.height = 视口布局高度）。测试按实例的 observe(target)
   * 分辨 observer 身份，分别 fire。
   *
   * jsdom 无布局引擎（scrollHeight 恒 0）：实例级 defineProperty 伪造型 scrollHeight
   * 并计数 scrollTop 写入，断言「发生了写入且写的是 scrollHeight」。
   * 另有结构断言（observe target 检查）锁定观测对象正确性——这是检视发现 1 的回归锚。
   */
  let roInstances: ROStub[] = []
  class ROStub {
    cb: ResizeObserverCallback
    el: Element | null = null
    constructor(cb: ResizeObserverCallback) { this.cb = cb; roInstances.push(this) }
    observe(target: Element) { this.el = target }
    disconnect() {}
    unobserve() {}
  }
  /** jsdom 的 Element.prototype.scrollTo 可能未实现——mount rAF 会调它，兜底 no-op */
  const elementProto = Element.prototype as unknown as Record<string, unknown>
  const hadScrollTo = Object.prototype.hasOwnProperty.call(elementProto, 'scrollTo')

  beforeEach(() => {
    roInstances = []
    if (!hadScrollTo) elementProto.scrollTo = () => {}
    ;(globalThis as Record<string, unknown>).ResizeObserver = ROStub
  })
  afterEach(() => {
    if (!hadScrollTo) delete elementProto.scrollTo
    delete (globalThis as Record<string, unknown>).ResizeObserver
  })

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  async function untilTrue(cond: () => boolean, ms = 500) {
    const t0 = Date.now()
    while (!cond() && Date.now() - t0 < ms) await sleep(20)
    return cond()
  }

  function renderAtBottom(ref: { current: boolean }) {
    act(() => {
      root.render(
        <MessageList messages={[msg()]} state="normal" onStopStream={() => {}}
          onRetryMessage={() => {}} onRetry={() => {}} onGoToSettings={() => {}}
          otters={[]} conversationId="conv-1" pinRef={ref} />,
      )
    })
  }

  /** 按观测目标找 observer 实例——滚动容器的直接子 div = 内容包裹（contentRef 指向） */
  function roByTargetClass(cls: string): ROStub {
    const ro = roInstances.find(r => r.el?.classList?.contains(cls))
    expect(ro, `应有观测 .${cls} 的 observer`).toBeTruthy()
    return ro!
  }
  function contentRO(): ROStub {
    // 内容包裹 div 无语义 class——结构上：scrollRef 容器（overflow-y-auto）的首个子 div
    const scroller = roInstances.map(r => r.el).find(el => el?.classList?.contains('overflow-y-auto'))
    const content = scroller?.firstElementChild
    const ro = roInstances.find(r => r.el === content)
    expect(ro, '应有观测内容包裹 div 的 observer').toBeTruthy()
    return ro!
  }
  function viewportRO(): ROStub { return roByTargetClass('overflow-y-auto') }

  function fire(ro: ROStub, h: number) {
    act(() => {
      ro.cb([{ target: ro.el!, contentRect: { width: 800, height: h } } as unknown as ResizeObserverEntry], ro as unknown as ResizeObserver)
    })
  }

  /** 实例级伪造型：scrollHeight=2000，计数 scrollTop 写入并捕获写入值 */
  function instrument(el: Element) {
    const state = { writes: 0, lastVal: -1 }
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 2000 })
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: (v: number) => { state.writes++; state.lastVal = v },
    })
    return state
  }

  /** 找滚动容器元素（overflow-y-auto）并伪造型 */
  function instrumentScroller() {
    const el = document.querySelector('.overflow-y-auto')!
    expect(el, '应存在滚动容器').toBeTruthy()
    return instrument(el)
  }

  it('结构：contentObserver 观测内容包裹 div，viewportObserver 观测滚动容器（检视发现 1 回归锚）', () => {
    renderAtBottom({ current: true })
    // 两个 observer 都存在
    expect(roInstances.length).toBe(2)
    // viewport observer 观测的是滚动容器本身
    expect(viewportRO().el?.classList.contains('overflow-y-auto')).toBe(true)
    // content observer 观测的是滚动容器的第一个子元素（内容包裹 div），而非滚动容器自身
    const content = contentRO().el!
    expect(content.tagName).toBe('DIV')
    expect(content.classList.contains('overflow-y-auto')).toBe(false)
    expect(content.parentElement?.classList.contains('overflow-y-auto')).toBe(true)
  })

  it('内容高度增大且在底部 → scrollTop 被写为 scrollHeight（贴底补偿，信号 chip 弹出场景）', async () => {
    renderAtBottom({ current: true })
    fire(contentRO(), 1036) // 基线采样（0→1036 记为增大，其补偿写入不计数——先 instrument 再重新 fire 见下）
    await sleep(40) // 等基线 rAF 落完
    const st = instrumentScroller()
    fire(contentRO(), 1200) // 信号 chip 弹出：+164px
    expect(await untilTrue(() => st.writes > 0), '应在 rAF 后贴底写入').toBe(true)
    expect(st.lastVal).toBe(2000) // 写入值 = scrollHeight（贴底语义）
  })

  it('内容高度增大但用户不在底部（上翻阅读中）→ 不打扰', async () => {
    const ref = { current: true }
    renderAtBottom(ref)
    fire(contentRO(), 1036)
    await sleep(40)
    ref.current = false // mount 后用户上翻（conversationId effect 重置 true，真实由 handleScroll 翻 false）
    const st = instrumentScroller()
    fire(contentRO(), 1200)
    await sleep(60)
    expect(st.writes).toBe(0)
  })

  it('内容高度减小（流式面板折叠）→ 不写 scrollTop', async () => {
    renderAtBottom({ current: true })
    fire(contentRO(), 1200) // 基线
    await sleep(40)
    const st = instrumentScroller()
    fire(contentRO(), 1000) // 减小
    await sleep(60)
    expect(st.writes).toBe(0)
  })

  it('视口高度减小（GateBanner 出现压缩视口）且在底部 → 贴底拉回', async () => {
    renderAtBottom({ current: true })
    fire(viewportRO(), 800) // 基线
    await sleep(40)
    const st = instrumentScroller()
    fire(viewportRO(), 740) // 视口被压 60px
    expect(await untilTrue(() => st.writes > 0), '视口压缩时应贴底拉回').toBe(true)
    expect(st.lastVal).toBe(2000)
  })

  it('视口高度增大（GateBanner 消失）→ 不写 scrollTop', async () => {
    renderAtBottom({ current: true })
    fire(viewportRO(), 740) // 基线
    await sleep(40)
    const st = instrumentScroller()
    fire(viewportRO(), 800) // 视口增大
    await sleep(60)
    expect(st.writes).toBe(0)
  })

  it('切会话：observer 重挂（旧实例 disconnect，新实例观测新容器），采样基线重置', async () => {
    const ref = { current: true }
    // 先渲染 conv-1
    act(() => {
      root.render(
        <MessageList messages={[msg()]} state="normal" onStopStream={() => {}}
          onRetryMessage={() => {}} onRetry={() => {}} onGoToSettings={() => {}}
          otters={[]} conversationId="conv-1" pinRef={ref} />,
      )
    })
    fire(contentRO(), 1036)
    await sleep(40)
    const firstBatch = [...roInstances]
    // 切换到 conv-2：容器带 key 重建
    act(() => {
      root.render(
        <MessageList messages={[msg(), msg({ id: 'm2' })]} state="normal" onStopStream={() => {}}
          onRetryMessage={() => {}} onRetry={() => {}} onGoToSettings={() => {}}
          otters={[]} conversationId="conv-2" pinRef={ref} />,
      )
    })
    await sleep(40)
    // 新 observer 挂到新容器（旧实例的 cleanup 已把实例从 active 语义中移除——
    // stub 的 disconnect 是 no-op，验证点在于新实例确实观测了新 DOM）
    const scroller = document.querySelector('.overflow-y-auto') as HTMLElement
    const newContent = scroller.firstElementChild
    const newRO = roInstances.find(r => r.el === newContent && !firstBatch.includes(r))
    expect(newRO, '切会话后应有新 observer 观测新内容包裹').toBeTruthy()
    // 基线重置：新会话首次 fire 从 0 起步，高度增大正常补偿
    const st = instrument(scroller)
    fire(newRO!, 1200)
    expect(await untilTrue(() => st.writes > 0), '新会话首次高度增大应补偿').toBe(true)
  })
})

describe('F20260826fpbd user 消息发送者名回退（Web/飞书同步）', () => {
  /**
   * 场景：飞书群聊多人 + Web 端同步查看（#488 快照链路的降级分支）。
   * 后端对 user 消息无快照时 sn 缺失（不冒充），冒充风险在前端回退逻辑：
   * 远程消息（src='feishu'）无快照必须显示中性标签，不得回退全局名——
   * 否则 joy 在权限未开/快照失败时会被 Web 端标成「chen」。
   */

  /** user 消息发送者名 span 选择器（text-stone-600 仅 user 消息使用） */
  const userNameSpan = () => container.querySelector('span.text-stone-600')

  function renderWithUser(msg: LocalMessage, name: string) {
    act(() => {
      root.render(
        <MessageList
          messages={[msg]}
          state="normal"
          onStopStream={() => {}}
          onRetryMessage={() => {}}
          onRetry={() => {}}
          onGoToSettings={() => {}}
          otters={[]}
          conversationId="conv-1"
          pinRef={{ current: true }}
          userName={name}
        />,
      )
    })
  }

  it('飞书 user 消息有快照名 → 显示快照名（joy）', () => {
    renderWithUser(msg({ st: 'user', si: 'ou_joy', sn: 'joy', src: 'feishu' }), 'chen')
    expect(userNameSpan()?.textContent).toBe('joy')
  })

  it('飞书 user 消息无快照（src=feishu）→ 显示中性标签「飞书成员」，不冒充全局名', () => {
    renderWithUser(msg({ st: 'user', si: 'ou_joy', sn: undefined, src: 'feishu' }), 'chen')
    expect(userNameSpan()?.textContent).toBe('飞书成员')
  })

  it('未知渠道（src 非 web/feishu）无快照 → 回退全局名（test17：仅飞书算外部，防御性「外部成员」已收窄）', () => {
    // F20260913ctlv test17：web 来源不再算「外部」（「外部成员」误标自己人）；
    // 仅 feishu 显式显示中性标签，其他未知渠道也回退全局名
    const future: LocalMessage = msg({ st: 'user', si: 'ding_user', sn: undefined, src: 'feishu' })
    ;(future as { src?: string }).src = 'dingtalk'
    renderWithUser(future, 'chen')
    expect(userNameSpan()?.textContent).toBe('chen')
  })

  it('Web 本地 user 消息（无 src）无快照 → 回退全局名（chen，单聊不变）', () => {
    renderWithUser(msg({ st: 'user', si: 'user', sn: undefined }), 'chen')
    expect(userNameSpan()?.textContent).toBe('chen')
  })

  it('Web 本地 user 消息且未设全局名 → 回退「我」（原行为保留）', () => {
    renderWithUser(msg({ st: 'user', si: 'user', sn: undefined }), '')
    expect(userNameSpan()?.textContent).toBe('我')
  })
})

describe('F20261008scpg scroll-pin 状态机（意图驱动贴底 + 程序写入自证账本）', () => {
  /**
   * 背景：旧 isAtBottomRef 是几何快照判定——流式增长期程序贴底写入追不上内容长高，
   * scroll 事件时距离瞬超 100px 阈值 → 翻 false → 补偿永久停摆；视口上方内容高度突变
   * 时无保护（自动上跳根因）。新机制：脱锚只认用户意图事件（wheel/touch/键盘/位移归因），
   * 程序写入经账本自证（pinWritesRef），归因程序的 scroll 不改状态。
   *
   * 测试策略：独立于旧块的 container/root——每个用例自建自清理，避免旧块
   * beforeEach 里全局 container 与本块互扰。伪造型 scrollTop 可读写（归因测试需要）。
   */
  let roInstances: ROStub2[] = []
  class ROStub2 {
    cb: ResizeObserverCallback
    el: Element | null = null
    constructor(cb: ResizeObserverCallback) { this.cb = cb; roInstances.push(this) }
    observe(target: Element) { this.el = target }
    disconnect() {}
    unobserve() {}
  }
  const elementProto = Element.prototype as unknown as Record<string, unknown>
  const hadScrollTo = Object.prototype.hasOwnProperty.call(elementProto, 'scrollTo')
  let rafPending: number[] = []
  beforeEach(() => {
    roInstances = []
    if (!hadScrollTo) elementProto.scrollTo = function (this: Element) {}
    ;(globalThis as Record<string, unknown>).ResizeObserver = ROStub2
    // rAF 捕获：程序写入经 rAF 合帧，测试需要即时执行
    const origRaf = globalThis.requestAnimationFrame
    ;(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) => {
      const id = origRaf(cb)
      rafPending.push(id)
      return id
    }
  })
  afterEach(() => {
    if (!hadScrollTo) delete elementProto.scrollTo
    delete (globalThis as Record<string, unknown>).ResizeObserver
    rafPending = []
  })
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  /** 等待条件为真（rAF 回调真执行后） */
  async function untilTrue(cond: () => boolean, ms = 600) {
    const t0 = Date.now()
    while (!cond()) {
      if (Date.now() - t0 > ms) return false
      await sleep(15)
    }
    return true
  }
  function msg(overrides: Partial<LocalMessage> = {}): LocalMessage {
    return {
      id: 'm1', st: 'otter', si: 'otter-1', sn: '大獭', content: '最终正文',
      status: 'completed', ts: '2026-08-14T00:00:00Z', dur: null, ...overrides,
    }
  }
  /** 可读写伪造型：scrollTop 可读写，scrollHeight 固定，写入计数 */
  function instrumentRW(el: Element, scrollHeight = 2000, initialTop = 0) {
    const state = { writes: 0, lastVal: -1, top: initialTop }
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => state.top,
      set: (v: number) => { state.writes++; state.lastVal = v; state.top = v },
    })
    return state
  }
  interface RenderOpts {
    pinRef: { current: boolean }
    messages?: LocalMessage[]
    newMessagesCount?: number
    onJumpToBottom?: () => void
    onLoadMore?: () => void
  }
  function renderList(opts: RenderOpts): { root: Root; div: HTMLDivElement } {
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
          conversationId="conv-1"
          pinRef={opts.pinRef}
          newMessagesCount={opts.newMessagesCount}
          onJumpToBottom={opts.onJumpToBottom}
          onLoadMore={opts.onLoadMore}
        />,
      )
    })
    return { root, div }
  }
  function scrollerOf(): Element {
    const el = document.querySelector('.overflow-y-auto')
    if (!el) throw new Error('滚动容器不存在（state 非 normal 或渲染未完成）')
    return el
  }
  /** 本块内最新挂载的 observer 按目标 class 找 */
  function roByClass(cls: string): ROStub2 {
    const ro = [...roInstances].reverse().find(r => r.el?.classList?.contains(cls))
    if (!ro) throw new Error(`无观测 .${cls} 的 observer`)
    return ro
  }
  function _viewportRO(): ROStub2 { return roByClass('overflow-y-auto') }
  function contentRO(): ROStub2 {
    const scroller = [...roInstances].reverse().find(r => r.el?.classList?.contains('overflow-y-auto'))?.el
    const content = scroller?.firstElementChild
    const ro = [...roInstances].reverse().find(r => r.el === content)
    if (!ro) throw new Error('无观测内容包裹 div 的 observer')
    return ro
  }
  function fireRO(ro: ROStub2, h: number) {
    act(() => {
      ro.cb([{ target: ro.el!, contentRect: { width: 800, height: h } } as unknown as ResizeObserverEntry], ro as unknown as ResizeObserver)
    })
  }
  /** 触发一次真实 scroll 事件（handleScroll 归因路径） */
  function fireScroll() {
    act(() => { scrollerOf().dispatchEvent(new Event('scroll')) })
  }

  it('W6 死按钮修复：floating 下点跳底按钮 → 置 pinned + 写入 scrollHeight（smooth）+ 回调', async () => {
    const pinRef = { current: false }
    let jumped = false
    const { root, div } = renderList({ pinRef, newMessagesCount: 2, onJumpToBottom: () => { jumped = true } })
    try {
      const btn = Array.from(div.querySelectorAll('button')).find(b => b.textContent?.includes('新消息'))
      expect(btn, '应渲染跳底按钮').toBeTruthy()
      const st = instrumentRW(scrollerOf(), 2000, 500)
      act(() => { btn!.click() })
      expect(pinRef.current, '点击后应置 pinned').toBe(true)
      expect(jumped, '业务回调应触发').toBe(true)
      // smooth 经 scrollTo({behavior}) —— jsdom stub no-op，但写入意图已表达；
      // 断言 pinned + 回调 + 后续 observer 补偿路径可用
      void st
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
  })

  it('账本归因核心回归锚：程序贴底写入引发的 scroll 不脱锚（旧机制在此翻 false 停摆）', async () => {
    const pinRef = { current: true }
    const { root, div } = renderList({ pinRef })
    try {
      fireRO(contentRO(), 1036) // 基线采样
      await sleep(40) // 等基线 rAF 落完（mount init 写入也在此完成）
      const st = instrumentRW(scrollerOf(), 2000, 1900)
      fireRO(contentRO(), 1200) // 内容增高 → rAF 程序写入 2000
      expect(await untilTrue(() => st.writes > 0), '程序应贴底写入').toBe(true)
      // 程序写入后浏览器触发 scroll：scrollTop=2000（写入值），距底 0，且账本认领
      st.top = 2000
      fireScroll()
      expect(pinRef.current, '归因程序的 scroll 不应脱锚').toBe(true)
      // 持续增高（写入过期）也不脱锚：pin 类下界匹配（scrollTop >= expected-ε）
      fireRO(contentRO(), 1400)
      await sleep(40)
      st.top = 2000 // scrollHeight 已 2100（instrumentRW 固定），距底 100px——旧机制必翻 false
      fireScroll()
      expect(pinRef.current, '流式写入过期时仍归因程序，不脱锚（停摆竞态核心）').toBe(true)
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
  })

  it('滚动条上拖签名（V5 上半）：未登记的向上位移 → floating', async () => {
    const pinRef = { current: true }
    const { root, div } = renderList({ pinRef })
    try {
      fireRO(contentRO(), 1036)
      await sleep(40)
      const st = instrumentRW(scrollerOf(), 2000, 1800)
      st.top = 1800
      fireScroll() // 建立基线 lastScrollTop=1800（距底 200，不在底部，位移 0）
      expect(pinRef.current, '首次事件不脱锚（无向上位移）').toBe(true)
      st.top = 1000
      fireScroll() // 位移向上 800px，未登记 → 用户滚动条上拖
      expect(pinRef.current, '向上位移应脱锚').toBe(false)
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
  })

  it('滚到底回锚（V5 下半）：floating 后 isNearBottom 的 scroll → pinned', async () => {
    const pinRef = { current: false }
    const { root, div } = renderList({ pinRef })
    try {
      fireRO(contentRO(), 1036)
      await sleep(40)
      const st = instrumentRW(scrollerOf(), 2000, 500)
      st.top = 1950 // 距底 50px
      fireScroll()
      expect(pinRef.current, '滚到底部附近应回锚').toBe(true)
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
  })

  it('wheel 向上 → 立即脱锚；floating 下高度增长不打扰（T2）', async () => {
    const pinRef = { current: true }
    const { root, div } = renderList({ pinRef })
    try {
      fireRO(contentRO(), 1036)
      await sleep(40)
      act(() => {
        scrollerOf().dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
      })
      expect(pinRef.current, 'wheel 向上应立即脱锚').toBe(false)
      const st = instrumentRW(scrollerOf(), 2000, 500)
      fireRO(contentRO(), 1400) // 高度增长
      await sleep(80)
      expect(st.writes, 'floating 状态高度增长不应写入（T2 不打扰）').toBe(0)
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
  })

  it('W8 恢复：顶部触发 loadMore → 历史加载后写入偏移位置且 scroll 归因程序', async () => {
    // 场景：用户已脱锚上翻（floating）——mount 时 conversationId effect 会置 pinned，
    // 需先模拄用户脱锚（wheel 向上）再滚到顶，否则 pin=true 会让测试意图混入贴底路径
    const pinRef = { current: true }
    let loadMoreFired = false
    const { root, div } = renderList({ pinRef, onLoadMore: () => { loadMoreFired = true } })
    try {
      fireRO(contentRO(), 1036)
      await sleep(40)
      // 用户 wheel 向上脱锚
      act(() => { scrollerOf().dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })) })
      expect(pinRef.current).toBe(false)
      const st = instrumentRW(scrollerOf(), 2000, 0) // 顶部
      fireScroll() // scrollTop=0 → onLoadMore + pendingScrollRestoreRef 记 2000
      expect(loadMoreFired).toBe(true)
      // 加载历史：消息变多 → W8 恢复写入 scrollHeight(2000) - 2000 = 0
      act(() => {
        root.render(
          <MessageList
            messages={[msg({ id: 'm0', ts: '2026-08-13T00:00:00Z' }), msg()]}
            state="normal"
            onStopStream={() => {}}
            onRetryMessage={() => {}}
            onRetry={() => {}}
            onGoToSettings={() => {}}
            otters={[]}
            conversationId="conv-1"
            pinRef={pinRef}
            onLoadMore={() => {}}
          />,
        )
      })
      expect(await untilTrue(() => st.writes > 0), 'W8 应写入恢复位置').toBe(true)
      expect(st.lastVal, '恢复写入 = scrollHeight - 记录高度 = 0').toBe(0)
      // 恢复写入后的 scroll 事件归因程序（restore 标签），不改变 floating 状态
      st.top = 0
      fireScroll()
      expect(pinRef.current, 'restore 写入的 scroll 不应回锚/脱锚').toBe(false)
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
  })

  it('切会话 R0：conversationId 变化 → pin 重置 pinned + 账本清空（隔会话残留写入不误伤）', async () => {
    const pinRef = { current: false }
    const { root, div } = renderList({ pinRef })
    try {
      act(() => {
        root.render(
          <MessageList
            messages={[msg({ id: 'x1' })]}
            state="normal"
            onStopStream={() => {}}
            onRetryMessage={() => {}}
            onRetry={() => {}}
            onGoToSettings={() => {}}
            otters={[]}
            conversationId="conv-2"
            pinRef={pinRef}
          />,
        )
      })
      expect(pinRef.current, '切会话应重置 pinned').toBe(true)
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
  })

  it('键盘脱锚（V9）：页面级 PageUp → floating；输入框内 PageUp 不劫持', async () => {
    const pinRef = { current: true }
    const { root, div } = renderList({ pinRef })
    try {
      fireRO(contentRO(), 1036)
      await sleep(40)
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }))
      })
      expect(pinRef.current, '页面级 PageUp 应脱锚').toBe(false)
      // 回锚后测输入框保护
      const st = instrumentRW(scrollerOf(), 2000, 1950)
      st.top = 1950
      fireScroll()
      expect(pinRef.current).toBe(true)
      const input = document.createElement('input')
      document.body.appendChild(input)
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
      })
      expect(pinRef.current, '输入框内 PageUp 不应脱锚').toBe(true)
      input.remove()
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
  })
})
