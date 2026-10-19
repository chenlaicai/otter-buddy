// @vitest-environment jsdom
/**
 * F20261016pcov 卡片预览槽位进覆盖层（搭档 10-16 报告「交互卡片触发的回答点不了」）。
 *
 * 根因：预览卡是 main 文档流子元素（MessageList 后），输入框覆盖层（absolute bottom-0
 * z-10）叠其上——透明但命中测试照吃，发送/拒绝按钮点击全被吞。
 * 修法：卡片挪进覆盖层内（分割条下方、输入框上方）。
 *
 * 单测锁 DOM 结构契约（点击真值由 e2e input-fixed-split-visual spec 场景 7/8 承载——
 * 真浏览器 hit-test 才是本 bug 的复现条件，jsdom 无布局无法复现点击被吞）：
 * - 卡片在 overlay 容器内（= z-10 同层，无叠放冲突）
 * - 卡片在分割条之后、MessageInput 之前（z 序：分割条 > 卡片 > 输入框）
 * - 卡片出现时 overlay 实高变化 → bottomSpacerPx 同步（衬垫含卡片——按钮不被消息压住）
 * - 卡片消失 → bottomSpacerPx 回落
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

const CARD_PREVIEW: CardPreview = {
  cardId: 'msg-1:0',
  authorId: 'otter-1',
  summary: '卡片提交摘要：确认发送以下内容',
  dataJson: '{"answer": "是"}',
  data: { answer: '是' },
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

describe('F20261016pcov 卡片预览槽位进覆盖层', () => {
  it('卡片在覆盖层容器内（DOM 结构契约：不再被输入覆盖层叠放吞点击）', () => {
    const { container } = renderChatView(CARD_PREVIEW)
    const overlay = overlayEl(container)
    const card = container.querySelector('[data-testid="card-preview"]')
    expect(card, '卡片应渲染').toBeTruthy()
    expect(overlay.contains(card), '卡片必须是覆盖层的子元素（旧 bug：文档流子元素被覆盖层叠住）').toBe(true)
  })

  it('z 序契约：卡片在分割条之后、MessageInput 之前（分割条恒为输入区含卡片的顶沿）', () => {
    const { container } = renderChatView(CARD_PREVIEW)
    const overlay = overlayEl(container)
    const kids = Array.from(overlay.children)
    const splitterIdx = kids.findIndex(k => k.getAttribute('role') === 'separator')
    const cardIdx = kids.findIndex(k => k.getAttribute('data-testid') === 'card-preview')
    const inputIdx = kids.findIndex(k => k.querySelector?.('.glass-input'))
    expect(splitterIdx).toBeGreaterThanOrEqual(0)
    expect(cardIdx).toBeGreaterThan(splitterIdx)
    expect(inputIdx).toBeGreaterThan(cardIdx)
  })

  it('发送/拒绝按钮回调连通（props 透传不被吞）', async () => {
    const onConfirm = vi.fn()
    const onReject = vi.fn()
    const conversation = { id: 'conv-1', title: 't', status: 'active' } as unknown as LocalConversation
    const pinRef = createRef<boolean>() as React.MutableRefObject<boolean>
    pinRef.current = true
    const { container } = render(
      <ChatView
        conversation={conversation}
        messages={[]} state="normal" onSend={vi.fn()} onStopStream={vi.fn()}
        onRetryMessage={vi.fn()} onRetry={vi.fn()} onGoToSettings={vi.fn()} onArchive={vi.fn()}
        otters={[]} conversationId="conv-1" pinRef={pinRef}
        cardPreview={CARD_PREVIEW} onConfirmCard={onConfirm} onRejectCard={onReject}
      />,
    )
    const card = container.querySelector('[data-testid="card-preview"]')!
    const buttons = Array.from(card.querySelectorAll('button'))
    const confirmBtn = buttons.find(b => b.textContent === '发送')!
    const rejectBtn = buttons.find(b => b.textContent === '拒绝')!
    confirmBtn.click()
    rejectBtn.click()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it('衬垫含卡片：卡片出现 → overlay RO 实高含卡片 → bottomSpacerPx 同步给 MessageList', () => {
    const { container, rerender } = renderChatView(null)
    const overlay = overlayEl(container)
    // 无卡片：overlay 实高 = 分割条 + 输入区
    fireOverlayRO(overlay, 150)
    const spacerWithCard0 = messageListMock.mock.calls[messageListMock.mock.calls.length - 1]?.[0].bottomSpacerPx
    expect(spacerWithCard0).toBe(150)

    // 卡片出现：overlay 长高（模拟 RO 报 280 = 150 + 卡片 130）
    const conversation = { id: 'conv-1', title: 't', status: 'active' } as unknown as LocalConversation
    const pinRef = createRef<boolean>() as React.MutableRefObject<boolean>
    pinRef.current = true
    rerender(
      <ChatView
        conversation={conversation}
        messages={[]} state="normal" onSend={vi.fn()} onStopStream={vi.fn()}
        onRetryMessage={vi.fn()} onRetry={vi.fn()} onGoToSettings={vi.fn()} onArchive={vi.fn()}
        otters={[]} conversationId="conv-1" pinRef={pinRef}
        cardPreview={CARD_PREVIEW} onConfirmCard={vi.fn()} onRejectCard={vi.fn()}
      />,
    )
    const overlay2 = overlayEl(container)
    expect(overlay2.querySelector('[data-testid="card-preview"]'), 'rerender 后卡片仍在覆盖层内').toBeTruthy()
    fireOverlayRO(overlay2, 280)
    const spacerWithCard = messageListMock.mock.calls[messageListMock.mock.calls.length - 1]?.[0].bottomSpacerPx
    expect(spacerWithCard, '衬垫随 overlay 实高（含卡片）同步').toBe(280)
  })

  it('无卡片时行为不变（回归锚：卡片块不渲染，overlay 结构与 F20261016inbs 一致）', () => {
    const { container } = renderChatView(null)
    expect(container.querySelector('[data-testid="card-preview"]')).toBeNull()
    const overlay = overlayEl(container)
    // 子元素只有分割条 + 输入区容器
    expect(overlay.children.length).toBe(2)
  })
})
