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
          otters={[]} conversationId="conv-1" isAtBottomRef={ref} />,
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
          otters={[]} conversationId="conv-1" isAtBottomRef={ref} />,
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
          otters={[]} conversationId="conv-2" isAtBottomRef={ref} />,
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
          isAtBottomRef={{ current: true }}
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
