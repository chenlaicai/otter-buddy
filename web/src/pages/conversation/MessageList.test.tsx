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

describe('F20260907sgpt 高度贴底补偿 + F20261010vwst 视口稳定优先（单 observer 化）', () => {
  /**
   * 背景：信号轨迹 chip / 徽标 / 流式面板折叠等不改 messages.length 的高度变化曾无任何补偿，
   * 用户在底部时视口周期性上跳（搭档 09-07 第五次报告同类现象）。
   *
   * F20261010vwst 结构性变更：原双 observer（content + viewport）中的 viewportObserver
   * 被整体删除——它把「输入框 autoResize / loadingMore 指示条 / 窗口缩小」等一切视口高度
   * 变化源都当成「需要贴底拉回」，导致贴底用户每输入一个换行就被程序性顶起一行（搭档
   * 10-10 报告）。视口高度变化时浏览器对 scrollTop 的 clamp 语义天然保证内容稳定，无需
   * 程序补偿；内容高度变化（该跟随的场景）由 contentObserver 独扛。
   * 视口稳定的行为级验证在 e2e（scroll-pin-frame-guard.spec.ts 场景 C，真实浏览器），
   * jsdom 无布局引擎，此处断言响应路径的结构性不存在：无任何 observer 观测滚动容器。
   *
   * contentObserver 测试按实例的 observe(target) 分辨 observer 身份后 fire。
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

  function contentRO(): ROStub {
    // 内容包裹 div 无语义 class——结构上：scrollRef 容器（overflow-y-auto）的首个子 div。
    // F20261010vwst：viewportObserver 已删，不再有 observer 观测滚动容器——改从 DOM 直取
    // （scroller.firstElementChild），再在 roInstances 里找观测它的实例
    const scroller = document.querySelector('.overflow-y-auto')
    const content = scroller?.firstElementChild
    const ro = roInstances.find(r => r.el === content)
    expect(ro, '应有观测内容包裹 div 的 observer').toBeTruthy()
    return ro!
  }

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

  it('结构（F20261010vwst）：仅 contentObserver 存在，无任何 observer 观测滚动容器（视口高度变化无程序响应路径）', () => {
    renderAtBottom({ current: true })
    // 单 observer：内容包裹 div 的观测者，别无分号
    expect(roInstances.length, '应只存在 contentObserver 一个 observer').toBe(1)
    // content observer 观测的是滚动容器的第一个子元素（内容包裹 div），而非滚动容器自身
    const content = contentRO().el!
    expect(content.tagName).toBe('DIV')
    expect(content.classList.contains('overflow-y-auto')).toBe(false)
    expect(content.parentElement?.classList.contains('overflow-y-auto')).toBe(true)
    // 无任何 observer 观测滚动容器——视口高度变化（输入框撑高/指示条/窗口 resize）
    // 不再存在程序性贴底响应路径（行为级验证在 e2e 场景 C：真实浏览器逐帧断言 scrollTop 稳定）
    const scrollerObserved = roInstances.some(r => r.el?.classList.contains('overflow-y-auto'))
    expect(scrollerObserved, '滚动容器不应被任何 observer 观测').toBe(false)
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

  // F20261010vwst 删除的两个旧锚（视口高度减小→贴底拉回 / 视口增大→不写）——其锚定的
  // viewportObserver 补偿分支被整体删除，删除理由与行为取舍见特性文档

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
  /** F20261020wcsr：IntersectionObserver stub——jsdom 无 IO。记录实例供用例手动 fire
   *  （isIntersecting 翻转 = 哨兵进入/离开视口的模拟） */
  let ioInstances: IOStub[] = []
  class IOStub {
    cb: IntersectionObserverCallback
    els: Element[] = []
    constructor(cb: IntersectionObserverCallback) { this.cb = cb; ioInstances.push(this) }
    observe(t: Element) { this.els.push(t) }
    unobserve(t: Element) { this.els = this.els.filter(e => e !== t) }
    disconnect() { this.els = [] }
    takeRecords(): IntersectionObserverEntry[] { return [] }
    get root() { return null } get rootMargin() { return '' } get thresholds() { return [0] }
  }
  /** fire 哨兵 intersecting 状态（取最新一个 IO 实例——哨兵 effect 是组件内唯一 IO 用户） */
  function fireSentinel(intersecting: boolean) {
    const io = ioInstances[ioInstances.length - 1]
    if (!io || io.els.length === 0) return
    act(() => {
      io.cb([{ isIntersecting: intersecting, target: io.els[0] } as unknown as IntersectionObserverEntry], io as unknown as IntersectionObserver)
    })
  }
  beforeEach(() => {
    roInstances = []
    ioInstances = []
    if (!hadScrollTo) elementProto.scrollTo = function (this: Element) {}
    ;(globalThis as Record<string, unknown>).ResizeObserver = ROStub2
    ;(globalThis as Record<string, unknown>).IntersectionObserver = IOStub
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
    delete (globalThis as Record<string, unknown>).IntersectionObserver
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
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 660 }) // F20261008w8lt：stillNearTop 守卫需要
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
    /** F20261027nmbf：回锚清零回调 */
    onPinnedToBottom?: () => void
    /** F20261027nmbf：底部衬垫高度（输入覆盖层实高） */
    bottomSpacerPx?: number
    onLoadMore?: () => void
    hasMoreBefore?: boolean
    loadingMore?: boolean
    loadMoreError?: boolean
    conversationId?: string
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
          conversationId={opts.conversationId ?? "conv-1"}
          pinRef={opts.pinRef}
          newMessagesCount={opts.newMessagesCount}
          onJumpToBottom={opts.onJumpToBottom}
          onPinnedToBottom={opts.onPinnedToBottom}
          bottomSpacerPx={opts.bottomSpacerPx}
          onLoadMore={opts.onLoadMore}
          hasMoreBefore={opts.hasMoreBefore}
          loadingMore={opts.loadingMore}
          loadMoreError={opts.loadMoreError}
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
  function contentRO(): ROStub2 {
    // F20261010vwst：viewportObserver 已删，无 observer 观测滚动容器——从 DOM 直取 scroller
    const scroller = document.querySelector('.overflow-y-auto')
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

  /** F20261027nmbf：浮窗几何修复——按钮 bottom 必须抬到输入覆盖层（bottomSpacerPx）之上，
   *  否则被覆盖层（absolute bottom-0 z-10）遮挡点不到（#1535 同族）。修复前 bottom 固定 16px */
  it('F20261027nmbf 几何：浮窗 bottom = 衬垫高+16，抬升到输入覆盖层上方（修复前 bottom 僵 16px 被覆盖）', async () => {
    const pinRef = { current: false }
    const { root, div } = renderList({ pinRef, newMessagesCount: 1, bottomSpacerPx: 96, onJumpToBottom: () => {} })
    try {
      const btn = Array.from(div.querySelectorAll('button')).find(b => b.textContent?.includes('新消息'))
      expect(btn, '应渲染跳底按钮').toBeTruthy()
      // 修复后：bottom = 96 + 16 = 112px，高于输入覆盖层实高（96px），不再被遮挡；
      // z-20 高于覆盖层 z-10，命中测试不再被透明覆盖层吞掉
      expect((btn as HTMLElement).style.bottom, 'bottom 应=衬垫+16').toBe('112px')
      expect((btn as HTMLElement).className, 'z 应高于覆盖层 z-10').toContain('z-20')
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
  })

  /** F20261027nmbf：计数僵死修复——floating→pinned 转换（滚回底部）即清零，不再依赖按钮可点。
   *  修复前：清零仅有点浮窗/发言两路，按钮被覆盖层遮挡时计数僵死。
   *  注：mount 时「切换会话重置」effect 置 pinRef=true，故用例内先手动置 floating 再触发回锚 */
  it('F20261027nmbf 回锚清零：floating 滚回底部（nearBottom）→ 触发 onPinnedToBottom 清零回调', async () => {
    const pinRef = { current: false }
    let cleared = 0
    const { root, div } = renderList({ pinRef, newMessagesCount: 3, onJumpToBottom: () => {}, onPinnedToBottom: () => { cleared++ } })
    try {
      const st = instrumentRW(scrollerOf(), 2000, 1950) // 距底 50px < 100 阈值 = nearBottom
      pinRef.current = false // mount 重置 effect 已置 true——手动回到 floating（模拟用户上翻后滚回）
      fireScroll()
      expect(pinRef.current, '滚回底部应回锚').toBe(true)
      expect(cleared, 'floating→pinned 转换应触发清零回调').toBe(1)
      // pinned 保持态重复 scroll 不重复触发（转换边缘触发）
      fireScroll()
      expect(cleared, 'pinned 保持不应重复触发').toBe(1)
      void st
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
  })

  it('F20261027nmbf 无计数不打：pinned 保持的重复 scroll 不触发清零回调（计数 0 时）', async () => {
    const pinRef = { current: true }
    let cleared = 0
    const { root, div } = renderList({ pinRef, onJumpToBottom: () => {}, onPinnedToBottom: () => { cleared++ } })
    try {
      instrumentRW(scrollerOf(), 2000, 1980)
      fireScroll()
      expect(cleared, '计数 0 时不触发回调').toBe(0)
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

  it('F20261020wcsr 兜底：绝对顶部 prepend → 增量写入保持位置（规范 §2.1 边界）', async () => {
    // 场景：floating 用户停留在绝对顶部（scrollTop=0），哨兵加载 prepend 50 条历史——
    // 规范 §2.1：锚点不选「未离开原点」的容器，浏览器锚定不工作，由手写兜底补偿：
    // 增量式写入 scrollTop = max(scrollTop + delta, 0)，方向构造性封闭
    const pinRef = { current: true }
    const { root, div } = renderList({ pinRef, onLoadMore: () => {} })
    try {
      // 脱锚进入 floating（顶部用户语义）+ 采样基线 top=0, sh=2000
      instrumentRW(scrollerOf(), 2000, 0)
      act(() => { scrollerOf().dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })) })
      fireScroll()
      expect(pinRef.current, 'wheel 上滚应脱锚').toBe(false)
      // 一次无关 commit（尾部追加）推进采样基线：首轮 mount 时 jsdom scrollHeight=0，
      // instrument 在 mount 后生效——必须再 commit 一次让 prevSh 采到 2000
      const base = msg()
      act(() => {
        root.render(
          <MessageList
            messages={[base, msg({ id: 'tail-x', ts: '2026-08-14T00:01:00Z' })]}
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
      expect(pinRef.current, '尾部追加不脱锚（采样推进后仍 floating）').toBe(false)
      // prepend：scrollHeight 2000→3000，头部 id 变化（50 条历史）
      const older = Array.from({ length: 50 }, (_, i) => msg({ id: `old-${i}`, ts: `2026-08-13T00:${String(i % 60).padStart(2, '0')}:00Z` }))
      Object.defineProperty(scrollerOf(), 'scrollHeight', { configurable: true, get: () => 3000 })
      act(() => {
        root.render(
          <MessageList
            messages={[...older, base, msg({ id: 'tail-x', ts: '2026-08-14T00:01:00Z' })]}
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
      // 兜底应增量写入：0 + (3000-2000) = 1000（原顶部消息回到视口顶）
      expect(pinRef.current, 'prepend 不改变用户意图（保持 floating）').toBe(false)
      const st = scrollerOf() as unknown as { scrollTop: number }
      expect(st.scrollTop, '兜底增量写入：scrollTop 应被推到新增高度差位置').toBe(1000)
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
  })

  it('F20261020wcsr 哨兵触发：intersecting → 加载；连拉限幅 3 批后冷却；向下位移解除', async () => {
    // 死锁回归锚（lmld 语义平移）：「到顶静止零位移无 scroll 事件」对 IO 不构成问题——
    // 哨兵 intersecting 状态变化由浏览器布局驱动，不依赖滚动事件
    const pinRef = { current: true }
    let loadCount = 0
    const rerenderIdle = () => act(() => {
      root.render(
        <MessageList
          messages={[msg()]}
          state="normal"
          onStopStream={() => {}}
          onRetryMessage={() => {}}
          onRetry={() => {}}
          onGoToSettings={() => {}}
          otters={[]}
          conversationId="conv-1"
          pinRef={pinRef}
          onLoadMore={() => { loadCount++ }}
          hasMoreBefore={true}
          loadingMore={false}
        />,
      )
    })
    const { root, div } = renderList({ pinRef, onLoadMore: () => { loadCount++ }, hasMoreBefore: true })
    try {
      expect(div.querySelector('[data-testid="load-sentinel"]'), 'hasMoreBefore=true 时应渲染哨兵').toBeTruthy()
      fireSentinel(true); expect(loadCount, '第 1 批').toBe(1)
      rerenderIdle(); fireSentinel(true); expect(loadCount, '第 2 批').toBe(2)
      rerenderIdle(); fireSentinel(true); expect(loadCount, '第 3 批（上限）').toBe(3)
      rerenderIdle(); fireSentinel(true); expect(loadCount, '冷却中自动通道静默').toBe(3)
      // 向下位移解除冷却（scrollTop 0→100）
      const st = instrumentRW(scrollerOf(), 2000, 0)
      fireScroll() // 基线采样 top=0
      st.top = 100
      fireScroll() // 0→100 向下位移
      fireSentinel(true); expect(loadCount, '冷却解除后恢复自动加载').toBe(4)
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
  })

  it('F20261020wcsr 哨兵门：loadingMore 不触发；手动按钮不受冷却限；hasMoreBefore=false 哨兵卸载', async () => {
    const pinRef = { current: true }
    let loadCount = 0
    const { root, div } = renderList({ pinRef, onLoadMore: () => { loadCount++ }, hasMoreBefore: true, loadingMore: true })
    try {
      fireSentinel(true)
      expect(loadCount, 'loadingMore 期间不触发').toBe(0)
      // loadingMore 翻 false 后打满 3 批冷却
      const rerenderIdle = () => act(() => {
        root.render(
          <MessageList
            messages={[msg()]}
            state="normal"
            onStopStream={() => {}}
            onRetryMessage={() => {}}
            onRetry={() => {}}
            onGoToSettings={() => {}}
            otters={[]}
            conversationId="conv-1"
            pinRef={pinRef}
            onLoadMore={() => { loadCount++ }}
            hasMoreBefore={true}
            loadingMore={false}
          />,
        )
      })
      rerenderIdle(); fireSentinel(true)
      rerenderIdle(); fireSentinel(true)
      rerenderIdle(); fireSentinel(true)
      expect(loadCount, '3 批打满').toBe(3)
      // 手动按钮不受冷却限（冷却非全局闸）
      const btn = [...div.querySelectorAll('button')].find(b => b.textContent?.includes('加载更早'))
      expect(btn, 'hasMoreBefore=true 时应渲染可见按钮').toBeTruthy()
      act(() => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(loadCount, '手动按钮不受冷却限').toBe(4)
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
    // hasMoreBefore=false：哨兵不渲染（生命周期闭合/防假入口——按钮防假入口由 lmld 既有用例覆盖）
    const v2 = renderList({ pinRef: { current: true }, hasMoreBefore: false, onLoadMore: () => { loadCount++ } })
    try {
      expect(v2.div.querySelector('[data-testid="load-sentinel"]'), 'hasMoreBefore=false 时哨兵不渲染').toBeNull()
    } finally {
      act(() => { v2.root.unmount() })
      v2.div.remove()
    }
  })

  it('F20261021lmfe 失败态反馈：loadMoreError → 按钮错误态可重试；哨兵自动通道阻断（防失败重试风暴）', async () => {
    const pinRef = { current: true }
    let loadCount = 0
    const { root, div } = renderList({ pinRef, onLoadMore: () => { loadCount++ }, hasMoreBefore: true, loadMoreError: true })
    try {
      // 失败态按钮：用户可见的错误反馈 + 可点击重试（不是 disabled 死按钮）
      const btn = [...div.querySelectorAll('button')].find(b => b.textContent?.includes('加载'))
      expect(btn, 'hasMoreBefore=true 时应渲染可见按钮').toBeTruthy()
      expect(btn!.textContent, '失败态按钮文案必须自明（加载失败+重试指引）').toContain('加载失败')
      expect(btn!.textContent, '重试入口指引').toContain('重试')
      expect((btn as HTMLButtonElement).disabled, '失败态按钮必须可点击（重试入口）').toBe(false)
      // 哨兵自动通道阻断：error 态下 IO 触发不得自动重试（否则失败→重挂→再拉循环风暴）
      fireSentinel(true)
      expect(loadCount, 'error 态自动通道必须静默').toBe(0)
      // 手动点击仍放行（重试入口可用）
      act(() => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(loadCount, '手动按钮不受 error 阻断').toBe(1)
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
    // error 清除后按钮恢复常态文案、自动通道恢复
    const v2 = renderList({ pinRef: { current: true }, onLoadMore: () => { loadCount++ }, hasMoreBefore: true, loadMoreError: false })
    try {
      const btn2 = [...v2.div.querySelectorAll('button')].find(b => b.textContent?.includes('加载'))
      expect(btn2!.textContent, 'error 清除后按钮恢复常态').toContain('加载更早消息')
      fireSentinel(true)
      expect(loadCount, 'error 清除后自动通道恢复').toBe(2)
    } finally {
      act(() => { v2.root.unmount() })
      v2.div.remove()
    }
  })

  it('F20261020wcsr 结构：scroll 容器无 overflow-anchor:none（浏览器锚定启用）', async () => {
    const { root, div } = renderList({ pinRef: { current: true } })
    try {
      const sc = div.querySelector('.overflow-y-auto') as HTMLElement
      expect(sc, '应存在滚动容器').toBeTruthy()
      expect(sc.style.overflowAnchor, '不应显式关闭浏览器锚定（F20261020wcsr 启用）').not.toBe('none')
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

  it('审视建议补测①：向下滚（wheel deltaY>0）不接管——跟随态不被向底手势破坏', async () => {
    const pinRef = { current: true }
    const { root, div } = renderList({ pinRef })
    try {
      fireRO(contentRO(), 1036)
      await sleep(40)
      act(() => {
        scrollerOf().dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
      })
      expect(pinRef.current, '向底 wheel 不应脱锚').toBe(true)
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
  })

  it('近底小幅上滚脱锚（F20261016inbs 弹回 bug 根因回归锚）：pinned 用户滚到距底 40px 处 wheel 上滚 30px → 必须脱锚，不得被「未归因且近底→回锚」吞掉', async () => {
    // 复现派工描述的 bug：wheel 脱锚（takeUserControl 置 floating）后，紧随的 scroll 事件
    // 中位移不足 100px 仍在底部附近（isNearBottom 阈值 100）→ 旧实现的 else 分支
    // 「未归因且近底 → pinRef.current = true」重新贴底，覆盖 wheel 意图；下一次 React 提交
    // （流式期间几乎每 token 一次）执行贴底写入 → 弹回最下方。单次位移超 100px 才能逃掉。
    const pinRef = { current: true }
    const { root, div } = renderList({ pinRef })
    try {
      fireRO(contentRO(), 1036)
      await sleep(40)
      // 滚到距底 40px：scrollTop = 2000 - 660 - 40 = 1300（仍在 100px 阈值内 = 近底）。
      // 先 fireScroll 建立基线（真实浏览器中贴底用户历经多次 scroll 事件，采样基线存在；
      // jsdom 程序写入不触发事件，需显式建立）
      const st = instrumentRW(scrollerOf(), 2000, 1300)
      st.top = 1300
      fireScroll() // 基线：lastScrollTop=1300（位移 0，维持 pinned）
      expect(pinRef.current).toBe(true)
      // 用户 wheel 向上脱锚（真实事件通道）
      act(() => { scrollerOf().dispatchEvent(new WheelEvent('wheel', { deltaY: -30 })) })
      expect(pinRef.current, 'wheel 向上应立即脱锚').toBe(false)
      // 紧随的 scroll 事件：位移向上 30px（不足 100px，距底 70px 仍近底）——旧实现在此回锚
      st.top = 1270
      fireScroll()
      expect(pinRef.current, '近底小幅上滚的 scroll 必须保持脱锚（这是弹回 bug 的核心断言）').toBe(false)
      // 下一次内容增长（流式 token）：floating 不打扰，无贴底写入（弹回消失）
      fireRO(contentRO(), 1400)
      await sleep(80)
      expect(st.writes, '脱锚后内容增长不得写入 scrollTop（弹回路径）').toBe(0)
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
  })

  it('内容收缩 clamp 保护（F20261016inbs）：scrollHeight 缩小引发的向下 clamp 位移不脱锚不回锚，pinned 保持 pinned', async () => {
    // 场景：pinned 用户 + 内容收缩（如流式面板折叠）→ scrollHeight 缩小 → 浏览器 clamp
    // 把 scrollTop 压低（位移向上）→ 若只按「向上位移一律脱锚」会误伤 pinned 用户。
    // 修法规格：scrollHeight 未缩小才脱锚；收缩期间 pinned 保持 pinned。
    // jsdom 伪造型：scrollHeight 从 2000 缩到 1300（缩 700），scrollTop 1300 → clamp 到 640
    const pinRef = { current: true }
    const { root, div } = renderList({ pinRef })
    try {
      fireRO(contentRO(), 1036)
      await sleep(40)
      const st = instrumentRW(scrollerOf(), 2000, 1300)
      st.top = 1300
      fireScroll() // 建立基线 lastScrollTop=1300, scrollHeight=2000
      expect(pinRef.current).toBe(true)
      // 内容收缩：scrollHeight 缩小 + clamp 向下压 scrollTop
      Object.defineProperty(scrollerOf(), 'scrollHeight', { configurable: true, get: () => 1300 })
      st.top = 640 // clamp 后位置（向上位移 660px）
      fireScroll()
      expect(pinRef.current, '内容收缩 clamp 期间 pinned 用户保持 pinned（不得误脱锚）').toBe(true)
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
  })

  it('F20261020wcsr 兜底守卫：切会话/非顶部/头部未变 三种场景兜底不触发', async () => {
    // 镜澜严重发现 2 回归锚：key remount 下「scrollTop=0」语义从「用户在顶部」漂移为
    // 「新容器刚 mount」，跨容器采样=垃圾写入——conversationId 守卫必须拦截
    const pinRef = { current: false }
    const { root, div } = renderList({ pinRef, conversationId: 'conv-a' })
    try {
      instrumentRW(scrollerOf(), 2000, 0)
      act(() => { scrollerOf().dispatchEvent(new Event('scroll')) }) // 采样基线 top=0, sh=2000
      // 场景 A：切会话（conversationId 变）+ 头部 id 变 + 上轮采样 0 → 守卫拦截，不增量写入
      const convB = [msg({ id: 'b-1', ts: '2026-08-15T00:00:00Z' }), msg({ id: 'b-2', ts: '2026-08-15T00:01:00Z' })]
      act(() => {
        root.render(
          <MessageList
            messages={convB}
            state="normal"
            onStopStream={() => {}}
            onRetryMessage={() => {}}
            onRetry={() => {}}
            onGoToSettings={() => {}}
            otters={[]}
            conversationId="conv-b"
            pinRef={pinRef}
          />,
        )
      })
      // key remount 后容器是新的——新容器 scrollTop 初始 0，不应被写垃圾值
      const scB = div.querySelector('.overflow-y-auto') as HTMLElement
      instrumentRW(scB, 3000, 0)
      expect(scB.scrollTop, '切会话后兜底不触发（conversationId 守卫）').toBe(0)

      // 场景 B：同会话、用户不在顶部（上轮采样 >0）→ 不触发（该场景由浏览器锚定接管）
      // 上翻阅读用户语义 = floating：先 wheel 脱锚（mount/切会话重置 pin=true）
      instrumentRW(scB, 3000, 500)
      act(() => { scB.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })) })
      act(() => { scB.dispatchEvent(new Event('scroll')) }) // 位移归因基线
      expect(pinRef.current, '场景 B 前提：floating').toBe(false)
      // 一次无关 commit（尾部追加）推进兜底采样基线（首轮 mount 采样为 jsdom 原生值 0）
      const convB2 = [...convB, msg({ id: 'b-x', ts: '2026-08-15T00:01:30Z' })]
      act(() => {
        root.render(
          <MessageList
            messages={convB2}
            state="normal"
            onStopStream={() => {}}
            onRetryMessage={() => {}}
            onRetry={() => {}}
            onGoToSettings={() => {}}
            otters={[]}
            conversationId="conv-b"
            pinRef={pinRef}
          />,
        )
      })
      const prepended = [msg({ id: 'b-0', ts: '2026-08-14T23:59:00Z' }), ...convB2]
      Object.defineProperty(scB, 'scrollHeight', { configurable: true, get: () => 3500 })
      act(() => {
        root.render(
          <MessageList
            messages={prepended}
            state="normal"
            onStopStream={() => {}}
            onRetryMessage={() => {}}
            onRetry={() => {}}
            onGoToSettings={() => {}}
            otters={[]}
            conversationId="conv-b"
            pinRef={pinRef}
          />,
        )
      })
      expect(scB.scrollTop, '非顶部 prepend 兜底不触发（锚定场景）').toBe(500)

      // 场景 C：同会话、在顶部、但尾部追加（头部 id 未变）→ 不触发
      instrumentRW(scB, 3500, 0)
      act(() => { scB.dispatchEvent(new Event('scroll')) })
      // 无关 commit 推进采样（同场景 B 理由）；内容用纯重渲即可（采样只读 DOM 值）
      act(() => {
        root.render(
          <MessageList
            messages={prepended}
            state="normal"
            onStopStream={() => {}}
            onRetryMessage={() => {}}
            onRetry={() => {}}
            onGoToSettings={() => {}}
            otters={[]}
            conversationId="conv-b"
            pinRef={pinRef}
          />,
        )
      })
      const tailAppended = [...prepended, msg({ id: 'b-3', ts: '2026-08-15T00:02:00Z' })]
      Object.defineProperty(scB, 'scrollHeight', { configurable: true, get: () => 3600 })
      act(() => {
        root.render(
          <MessageList
            messages={tailAppended}
            state="normal"
            onStopStream={() => {}}
            onRetryMessage={() => {}}
            onRetry={() => {}}
            onGoToSettings={() => {}}
            otters={[]}
            conversationId="conv-b"
            pinRef={pinRef}
          />,
        )
      })
      expect(scB.scrollTop, '尾部追加兜底不触发（头部 id 未变）').toBe(0)
    } finally {
      act(() => { root.unmount() })
      div.remove()
    }
  })

})

describe('F20261020wabt Web 消息链接全角尾巴修剪（渲染链集成）', () => {
  /**
   * 锁两件事：① REMARK_PLUGINS 顺序（remarkAutolinkTrim 须在 remarkBareLink 之前——
   * 顺序反了本测试红）② 全链路渲染行为（mdast 插件 → UnfurlAwareLink → <a href>）。
   * 单元层覆盖在 src/lib/remark-autolink-trim.test.ts，此处是集成的唯一锚。
   */
  function renderOtterBody(content: string) {
    act(() => {
      root.render(
        <MessageList
          messages={[msg({ content })]}
          state="normal"
          onStopStream={() => {}}
          onRetryMessage={() => {}}
          onRetry={() => {}}
          onGoToSettings={() => {}}
          otters={[]}
          conversationId="conv-1"
          pinRef={{ current: true }}
        />,
      )
    })
  }

  it('行内裸链带全角尾巴 → href 干净可点，尾巴留在链接外文本流', () => {
    renderOtterBody('任务已完成，服务仍在运行（http://127.0.0.1:5000）。')
    const a = container.querySelector('a[href^="http://127.0.0.1"]')
    expect(a, '链接应渲染').toBeTruthy()
    expect(a!.getAttribute('href'), 'href 不含全角尾巴').toBe('http://127.0.0.1:5000')
    expect(a!.textContent, '链接文本同步修剪').toBe('http://127.0.0.1:5000')
    // 尾巴回到链接外（阅读连续不丢字）
    expect(container.textContent).toContain('http://127.0.0.1:5000）。')
  })
})
