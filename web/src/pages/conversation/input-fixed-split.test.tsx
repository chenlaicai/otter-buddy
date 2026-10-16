// @vitest-environment jsdom
/**
 * F20261016inbs 输入框固定边界（分割条 + 双框独立滚动 + 动态衬垫）单测。
 *
 * 搭档拍板（微信式）：消息框/输入框隔离边界固定、两框各自滚动、输入内容绝不改变
 * 边界、用户可手动拖动分割条改变上下两框大小。
 *
 * 测试面：
 * - 分割条拖动 → 玻璃框固定高度变化（clamp 上下限）→ 松手持久化 localStorage
 * - mount 恢复持久化高度（异常值回退默认）
 * - overlay 实高 → bottomSpacerPx 透传给 MessageList（动态衬垫数据源）
 * - MessageList 渲染等高衬垫（bottomSpacerPx>0）且视口无写死 padding
 * - 输入内容不改变边界（textarea 多行 → 玻璃框高度不变）
 *
 * jsdom 无布局引擎：overlay 实高经 ResizeObserver stub fire 模拟；
 * 拖动经真实 pointer 事件序列（pointerdown → window pointermove → pointerup）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { createRef } from 'react'

vi.mock('./MessageList', () => ({
  // 记录 lastProps：断言 bottomSpacerPx 透传（spacer 渲染本体在 MessageList.test.tsx 直测）
  MessageList: vi.fn(() => <div data-testid="message-list-stub" />),
}))
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return { ...actual, uploadAttachments: vi.fn() }
})
vi.mock('../../components/Toast', () => ({ showToast: vi.fn() }))

import { ChatView } from './ChatView'
import { MessageList } from './MessageList'
import { MessageInput } from './MessageInput'
import type { LocalConversation, LocalOtter, LocalMessage } from '../../lib/mappers'

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

function renderChatView() {
  const conversation = { id: 'conv-1', title: 't', status: 'active' } as unknown as LocalConversation
  const pinRef = createRef<boolean>() as React.MutableRefObject<boolean>
  pinRef.current = true
  const utils = render(
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
    />,
  )
  return utils
}

/** 玻璃框容器（MessageInput 内 style={{height: inputHeight}} 的 flex flex-col div） */
function glassBox(container: HTMLElement): HTMLElement {
  const box = container.querySelector('.glass-input')?.parentElement as HTMLElement | null
  expect(box, '玻璃框外层固定高容器应存在').toBeTruthy()
  return box!
}

/** 触发 overlay ResizeObserver 回调（模拟 overlay 实高变化） */
function fireOverlayRO(container: HTMLElement, h: number) {
  const overlay = container.querySelector('[role="separator"]')?.parentElement as HTMLElement
  expect(overlay, 'overlay 容器应存在').toBeTruthy()
  const ro = [...roInstances].reverse().find(r => r.el === overlay)
  expect(ro, '应有观测 overlay 的 RO').toBeTruthy()
  act(() => {
    ro!.cb([{ target: overlay, contentRect: { width: 800, height: h } } as unknown as ResizeObserverEntry], ro as unknown as ResizeObserver)
  })
}

describe('F20261016inbs 分割条拖动 + 持久化', () => {
  it('拖动分割条 → 玻璃框固定高度变化（上拖变大）→ 松手持久化 localStorage', () => {
    const { container } = renderChatView()
    expect(glassBox(container).style.height).toBe('120px') // 默认 120
    const splitter = container.querySelector('[role="separator"]') as HTMLElement
    expect(splitter, '分割条热区应渲染').toBeTruthy()

    act(() => {
      splitter.dispatchEvent(new PointerEvent('pointerdown', { clientY: 500, bubbles: true }))
    })
    // 上拖 80px（clientY 减小 → 输入框变高）
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 420 }))
    })
    expect(glassBox(container).style.height, '上拖 80px → 200px').toBe('200px')
    // 松手 → 持久化
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup'))
    })
    expect(window.localStorage.getItem('otter.chat.inputHeight')).toBe('200')
  })

  it('clamp 下限 64px：下拖过头不缩没', () => {
    const { container } = renderChatView()
    const splitter = container.querySelector('[role="separator"]') as HTMLElement
    act(() => {
      splitter.dispatchEvent(new PointerEvent('pointerdown', { clientY: 500, bubbles: true }))
    })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 900 })) // 下拖 400px
    })
    expect(glassBox(container).style.height).toBe('64px')
    act(() => { window.dispatchEvent(new PointerEvent('pointerup')) })
    expect(window.localStorage.getItem('otter.chat.inputHeight')).toBe('64')
  })

  it('clamp 上限（容器高 55%）：上拖过大不无限长高', () => {
    const { container } = renderChatView()
    // jsdom clientHeight=0 → stub main（overlay 的父容器）高 600 → max = 330。
    // 层级：main > overlay(absolute) > splitter
    const splitter = container.querySelector('[role="separator"]') as HTMLElement
    const main = splitter.parentElement!.parentElement as HTMLElement
    Object.defineProperty(main, 'clientHeight', { configurable: true, get: () => 600 })
    act(() => {
      splitter.dispatchEvent(new PointerEvent('pointerdown', { clientY: 500, bubbles: true }))
    })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 0 })) // 上拖 500px → 620
    })
    expect(glassBox(container).style.height, '120+500=620 → clamp 到容器 55%=330').toBe('330px')
  })

  it('mount 恢复持久化高度；异常值（NaN/越界）回退默认 120', () => {
    window.localStorage.setItem('otter.chat.inputHeight', '180')
    const { container } = renderChatView()
    expect(glassBox(container).style.height, '恢复 180').toBe('180px')

    window.localStorage.setItem('otter.chat.inputHeight', 'abc')
    const utils2 = renderChatView()
    expect(glassBox(utils2.container).style.height, 'NaN 回退默认').toBe('120px')
    utils2.unmount()
  })
})

describe('F20261016inbs 动态衬垫（overlay 实高 → bottomSpacerPx）', () => {
  it('overlay RO 回调 → bottomSpacerPx 透传给 MessageList（取整）', () => {
    const { container } = renderChatView()
    fireOverlayRO(container, 200.4)
    expect(messageListMock).toHaveBeenCalled()
    const lastCall = messageListMock.mock.calls[messageListMock.mock.calls.length - 1]
    expect(lastCall?.[0].bottomSpacerPx).toBe(200)
  })

  it('衬垫随 overlay 实高动态变化（附件行出现 → overlay 长高 → 衬垫同步）', () => {
    const { container } = renderChatView()
    fireOverlayRO(container, 240) // 附件行出现，overlay 从 ~200 长到 240
    fireOverlayRO(container, 200) // 附件移除
    const lastCall = messageListMock.mock.calls[messageListMock.mock.calls.length - 1]
    expect(lastCall?.[0].bottomSpacerPx).toBe(200)
  })
})

describe('F20261016inbs 输入内容不改变边界（固定边界拍板）', () => {
  it('textarea 输入多行长文本 → 玻璃框高度不变（无任何内容驱动撑高路径）', () => {
    const { container } = renderChatView()
    const box = glassBox(container)
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea, 'textarea 应存在').toBeTruthy()
    // 多行长文本（field-sizing 时代会撑高到 max-h 120——固定边界时代高度纹丝不动）
    act(() => {
      textarea.value = Array.from({ length: 20 }, (_, i) => `第${i + 1}行长文本内容`).join('\n')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(box.style.height, '输入内容不改变边界（微信式固定边界）').toBe('120px')
  })
})

describe('F20261016inbs MessageInput 独立滚动（固定高度内部滚动）', () => {
  it('textarea 无 field-sizing/min-h/max-h 撑高类（高度由容器固定高 + h-full 决定）', () => {
    const utils = render(
      <MessageInput
        onSend={vi.fn()}
        disabled={false}
        otters={[] as LocalOtter[]}
        conversationId="conv-x"
        inputHeight={150}
        staged={[]}
        onRemoveAttachment={vi.fn()}
        onPickFiles={vi.fn()}
      />,
    )
    const textarea = utils.container.querySelector('textarea') as HTMLTextAreaElement
    const cls = textarea.className
    expect(cls, '内部滚动').toContain('overflow-y-auto')
    expect(cls, '无 field-sizing（内容驱动高度已删）').not.toContain('field-sizing')
    expect(cls, '无 max-h 撑高类').not.toContain('max-h-')
    expect(cls, '占满玻璃框').toContain('h-full')
    // 玻璃框固定高来自 inputHeight
    expect(glassBox(utils.container).style.height).toBe('150px')
    utils.unmount()
  })
})
