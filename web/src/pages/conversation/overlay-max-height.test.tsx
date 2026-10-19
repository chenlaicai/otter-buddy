// @vitest-environment jsdom
/**
 * F20261019ovmh（#1538）：输入覆盖层总高容器级封顶。
 *
 * 背景：#1535（F20261016pcov）把卡片预览迁入覆盖层后，覆盖层（分割条 + 预览卡 +
 * 输入框）总高无封顶——短视口 + 卡片数据区展开时覆盖层可吃掉整个消息区，聊天记录
 * 几乎不可见。挂账 S1，本单闭环。
 *
 * jsdom 无布局引擎，max-h/flex 收缩不真实生效——本文件锁的是**类名契约**（类名在
 * 即行为在：Tailwind 类由 CSS 赋义，浏览器布局语义由 e2e + 截图承载，同
 * card-preview-overlay.test.tsx 的分工先例）。覆盖：
 * - 覆盖层容器 max-h 封顶类 + flex-col + overflow-hidden（三件套缺一封顶失效：
 *   无 flex-col 则子元素不参与收缩、无 overflow-hidden 则溢出泄漏）
 * - 卡片可收缩（min-h-0——flex 子元素默认 min-height:auto 不收缩）+ 内容区
 *   overflow-y-auto（内部滚动）
 * - 按钮行 shrink-0（封顶挤压时发送/拒绝按钮恒可见——#1535 首要目标是按钮可点）
 * - 衬垫机制契约不变：RO 观测 overlay 实高（封顶 clamp 后的实高），spacer 同步——
 *   封顶不改代码，锁「机制未被破坏」回归锚
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { createRef } from 'react'

vi.mock('./MessageList', () => ({
  MessageList: vi.fn(() => <div data-testid="message-list-stub" />),
}))
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return { ...actual, uploadAttachments: vi.fn() }
})
vi.mock('../../components/Toast', () => ({ showToast: vi.fn() }))

import { ChatView } from './ChatView'
import { MessageList } from './MessageList'
import type { LocalConversation, LocalOtter, LocalMessage } from '../../lib/mappers'
import type { CardPreview } from './hooks/useCardBridge'

const messageListMock = vi.mocked(MessageList)

let roInstances: { cb: ResizeObserverCallback; el: Element | null }[] = []
class ROStub {
  cb: ResizeObserverCallback
  el: Element | null = null
  constructor(cb: ResizeObserverCallback) { this.cb = cb; roInstances.push(this) }
  observe(target: Element) { this.el = target }
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  roInstances = []
  messageListMock.mockClear()
  window.localStorage.clear()
  ;(globalThis as Record<string, unknown>).ResizeObserver = ROStub
})
afterEach(() => {
  delete (globalThis as Record<string, unknown>).ResizeObserver
})

/** 大卡片预览：summary 近上限（500 字符，html-card.ts CARD_SUMMARY_MAX_CHARS）+ 展开 JSON */
const BIG_CARD: CardPreview = {
  cardId: 'msg-1:0',
  authorId: 'otter-1',
  summary: '大卡片摘要：'.padEnd(50, '长') + '（近 500 字符上限的展开态场景）',
  dataJson: JSON.stringify({ rows: Array.from({ length: 40 }, (_, i) => ({ id: i, value: 'x'.repeat(60) })) }, null, 2),
  data: { rows: [] },
}

function renderChatView(cardPreview?: CardPreview | null) {
  const conversation = { id: 'conv-1', title: 't', status: 'active' } as unknown as LocalConversation
  const pinRef = createRef<boolean>() as React.MutableRefObject<boolean>
  pinRef.current = true
  return render(
    <ChatView
      conversation={conversation}
      messages={[] as LocalMessage[]}
      state="normal"
      onSend={vi.fn()}
      onStopStream={vi.fn()}
      onRetryMessage={vi.fn()}
      onRetry={vi.fn()}
      onGoToSettings={vi.fn()}
      onArchive={vi.fn()}
      otters={[] as LocalOtter[]}
      conversationId="conv-1"
      pinRef={pinRef}
      cardPreview={cardPreview ?? null}
      onConfirmCard={vi.fn()}
      onRejectCard={vi.fn()}
    />,
  )
}

function overlayEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.absolute.bottom-0') as HTMLElement | null
  expect(el, '覆盖层容器应存在').toBeTruthy()
  return el!
}

function fireOverlayRO(el: HTMLElement, h: number) {
  const ro = [...roInstances].reverse().find(r => r.el === el)
  expect(ro, '应有观测 overlay 的 RO').toBeTruthy()
  act(() => {
    ro!.cb([{ target: el, contentRect: { width: 800, height: h } } as unknown as ResizeObserverEntry], ro as unknown as ResizeObserver)
  })
}

describe('F20261019ovmh 覆盖层总高封顶（类名契约——布局语义由 e2e/截图承载）', () => {
  it('覆盖层容器封顶三件套：max-h-[60%] + flex-col（子元素参与收缩）+ 分割条 shrink-0（热区不被压没）', () => {
    const { container } = renderChatView(BIG_CARD)
    const overlay = overlayEl(container)
    const cls = overlay.className
    expect(cls, 'max-h 百分比锚 containing block=main（60vh 在矮窗口会大于 main 被 overflow-hidden 裁掉输入框）').toContain('max-h-[60%]')
    expect(cls).toContain('flex-col')
    // ⚠️ 容器不得加 overflow-hidden：分割条热区（h-2 -mt-2）靠负 margin 探出 overlay 顶沿
    // 8px，容器级裁切会把热区连同 hit-test 一起裁掉（拖拽失效，e2e 场景 2/3 实证）
    expect(cls, '容器级裁切会裁掉探出顶沿的分割条热区').not.toContain('overflow-hidden')
    const splitter = overlay.querySelector('[role="separator"]')!
    expect(splitter.className, '分割条热区是交互面，不参与 flex 收缩').toContain('shrink-0')
  })

  it('无卡片时封顶类同样在位（封顶是容器恒态，非卡片态特设）', () => {
    const { container } = renderChatView(null)
    const cls = overlayEl(container).className
    expect(cls).toContain('max-h-[60%]')
    expect(cls).toContain('flex-col')
  })
  it('卡片可收缩：min-h-0 + 内容区 overflow-y-auto（超限走内部滚动，不撑破封顶）', () => {
    const { container } = renderChatView(BIG_CARD)
    const card = container.querySelector('[data-testid="card-preview"]') as HTMLElement
    expect(card, '卡片应渲染').toBeTruthy()
    expect(card.className, 'flex 子元素默认 min-height:auto 不可收缩，min-h-0 是收缩前提').toContain('min-h-0')
    expect(card.className).toContain('overflow-hidden')
    // 内容区（summary + JSON）独立滚动
    const scrollArea = card.querySelector('.overflow-y-auto')
    expect(scrollArea, '内容区应有 overflow-y-auto（卡片超限时内部滚动）').toBeTruthy()
    expect(scrollArea!.querySelector('pre'), '数据 JSON 应在滚动区内').toBeTruthy()
  })

  it('按钮行恒可见：发送/拒绝按钮行 shrink-0（封顶挤压时不被滚出视野）', () => {
    const { container } = renderChatView(BIG_CARD)
    const card = container.querySelector('[data-testid="card-preview"]')!
    const sendBtn = Array.from(card.querySelectorAll('button')).find(b => b.textContent === '发送')!
    const btnRow = sendBtn.parentElement!
    expect(btnRow.className, '按钮行 shrink-0——#1535 首要目标是按钮可点，封顶不能把按钮滚出视野').toContain('shrink-0')
    // 按钮行在滚动区外（滚动区内滚没的不能是按钮）
    const scrollArea = card.querySelector('.overflow-y-auto')!
    expect(scrollArea.contains(sendBtn), '按钮必须在滚动区外（不被内容滚动带走）').toBe(false)
  })

  it('衬垫机制契约不变：RO 观测 overlay 实高（封顶后实高=clamp 值）→ bottomSpacerPx 同步', () => {
    const { container } = renderChatView(BIG_CARD)
    const overlay = overlayEl(container)
    // 模拟封顶生效后的实高（如 main 600px → 封顶 360px；未封顶自然高度本会是 550+）
    fireOverlayRO(overlay, 360)
    const spacer = messageListMock.mock.calls[messageListMock.mock.calls.length - 1]?.[0].bottomSpacerPx
    expect(spacer, '衬垫按 overlay 实际实高（封顶 clamp 后）同步——不会按未封顶自然高度错位').toBe(360)
  })

  it('分割条语义不变：恒为输入区（含卡片）顶沿，role=separator 仍是 overlay 首子元素', () => {
    const { container } = renderChatView(BIG_CARD)
    const overlay = overlayEl(container)
    const first = overlay.children[0]
    expect(first.getAttribute('role'), '分割条 z-20 在最上，拖动语义不因封顶改变').toBe('separator')
  })
})
