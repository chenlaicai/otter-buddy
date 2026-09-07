// @vitest-environment jsdom
/**
 * F20260814qswp：MessageList 流式过程面板事件渲染测试（AT-2 证据链最后一环）。
 *
 * 重试流 SSE 处理器曾产出 eventType:'text'/payload:{text} 的漂移形状，
 * EventItem 只识别 'assistant_text' 导致重试消息的流式文本事件静默丢失（return null）。
 * 本测试锁定：修复后形状（'assistant_text' + payload.content blocks）渲染文本预览；
 * 旧形状（'text'）不渲染任何事件行——防止再次漂移时无声回归。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MessageList } from './MessageList'
import type { LocalMessage, LocalMessageEvent } from '../../lib/mappers'

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

function render(list: LocalMessage[]) {
  act(() => {
    root.render(
      <MessageList
        messages={list}
        state="normal"
        onStopStream={() => {}}
        onRetryMessage={() => {}}
        onRetry={() => {}}
        onGoToSettings={() => {}}
        otters={[]}
        conversationId="conv-1"
        isAtBottomRef={{ current: true }}
      />,
    )
  })
}

/** 展开流式过程面板（终态默认折叠）。注意：需用原生 HTMLElement.click()，
 *  dispatchEvent(new MouseEvent) 不触发 React 合成事件 */
function expandProcessPanel() {
  const header = Array.from(container.querySelectorAll('div.streaming-section > div')).find(d => d.textContent?.includes('已完成'))
  expect(header, '未找到流式过程面板头').toBeTruthy()
  act(() => { (header as HTMLElement).click() })
}

describe('MessageList 流式过程面板事件渲染', () => {
  it('assistant_text 事件（修复后重试流形状）渲染徽标与文本预览', () => {
    const events: LocalMessageEvent[] = [{
      ts: '2026-08-14T00:00:01Z',
      eventType: 'assistant_text',
      payload: { content: [{ type: 'text', text: '这是重试流的第一段实时文本' }] },
    }]
    render([msg({ events })])
    expandProcessPanel()
    expect(container.textContent).toContain('assistant_text')
    expect(container.textContent).toContain('这是重试流的第一段实时文本')
  })

  it('旧漂移形状（eventType:text）不渲染事件行——回归对照', () => {
    const events: LocalMessageEvent[] = [{
      ts: '2026-08-14T00:00:01Z',
      eventType: 'text',
      payload: { text: '这段文本曾静默丢失' },
    }]
    render([msg({ events })])
    expandProcessPanel()
    expect(container.textContent).not.toContain('assistant_text')
    expect(container.textContent).not.toContain('这段文本曾静默丢失')
  })

  it('tool_result 事件正常渲染（同面板多事件类型共存）', () => {
    const events: LocalMessageEvent[] = [
      { ts: '2026-08-14T00:00:01Z', eventType: 'assistant_text', payload: { content: [{ type: 'text', text: '思考中' }] } },
      { ts: '2026-08-14T00:00:02Z', eventType: 'tool_result', payload: { name: 'search_memory', result: { content: [{ text: '结果预览' }] } } },
    ]
    render([msg({ events })])
    expandProcessPanel()
    expect(container.textContent).toContain('assistant_text')
    expect(container.textContent).toContain('tool_result')
    expect(container.textContent).toContain('search_memory')
  })

  it('无 events 的消息不渲染流式过程面板', () => {
    render([msg()])
    const header = Array.from(container.querySelectorAll('div')).find(d => d.textContent?.includes('已完成'))
    expect(header).toBeUndefined()
  })
})

describe('F20260907sgpt 高度贴底补偿（ResizeObserver）', () => {
  /**
   * 背景：信号轨迹 chip / 徽标 / GateBanner / 流式面板折叠等不改 messages.length 的
   * 高度变化曾无任何补偿，用户在底部时视口周期性上跳（搭档 09-07 第五次报告同类现象）。
   * 此测试锁定补偿行为：高度增大且在底部 → 贴底写入；上翻阅读 / 高度减小 → 不打扰。
   *
   * jsdom 无布局引擎（scrollHeight 恒 0）：用实例级 defineProperty 伪造型 scrollHeight
   * 并计数 scrollTop 写入，断言「发生了写入且写的是 scrollHeight」。
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
  /** jsdom 的 Element.prototype.scrollTo 可能未实现——await 真实定时器时 mount rAF 会调它，兜底成 no-op */
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

  function fire(h: number) {
    const ro = roInstances[0]
    expect(ro, 'MessageList 应注册 ResizeObserver').toBeTruthy()
    act(() => {
      ro.cb([{ target: ro.el!, contentRect: { width: 800, height: h } } as unknown as ResizeObserverEntry], ro as unknown as ResizeObserver)
    })
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

  it('高度增大且在底部 → scrollTop 被写为 scrollHeight（贴底补偿，信号 chip 弹出场景）', async () => {
    renderAtBottom({ current: true })
    fire(1036) // 基线采样（0→1036 记为增大，其补偿写入不计数）
    await sleep(40) // 等基线的 rAF 落完
    const el = roInstances[0].el!
    const st = instrument(el)
    fire(1200) // 信号 chip 弹出：+164px
    expect(await untilTrue(() => st.writes > 0), '应在 rAF 后贴底写入').toBe(true)
    expect(st.lastVal).toBe(2000) // 写入值 = scrollHeight（贴底语义）
  })

  it('高度增大但用户不在底部（上翻阅读中）→ 不打扰', async () => {
    const ref = { current: true }
    renderAtBottom(ref)
    // mount 后用户上翻（conversationId effect 会把 ref 重置为 true，真实上翻由 handleScroll 翻回 false）
    ref.current = false
    fire(1036)
    await sleep(40)
    const st = instrument(roInstances[0].el!)
    fire(1200)
    await sleep(60)
    expect(st.writes).toBe(0)
  })

  it('高度减小（如 GateBanner 消失）→ 不写 scrollTop（滚动条自然贴住新底）', async () => {
    renderAtBottom({ current: true })
    fire(1200) // 基线
    await sleep(40)
    const st = instrument(roInstances[0].el!)
    fire(1000) // 减小
    await sleep(60)
    expect(st.writes).toBe(0)
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

  it('未知渠道（src 非 web/feishu）无快照 → 「外部成员」兑底（运行时防御未来渠道）', () => {
    // 类型层 src 暂为窄联合；后端 DTO src 为宽松 string，未来新增渠道时此分支兜底
    const future: LocalMessage = msg({ st: 'user', si: 'ding_user', sn: undefined, src: 'feishu' })
    ;(future as { src?: string }).src = 'dingtalk'
    renderWithUser(future, 'chen')
    expect(userNameSpan()?.textContent).toBe('外部成员')
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
