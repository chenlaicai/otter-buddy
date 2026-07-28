// @vitest-environment jsdom
/** useCardBridge 安全闸门测试（F20260728htar P2-6）：
 *  jsdom + 手动 dispatch MessageEvent + mock registry/Toast 模块。
 *  覆盖：伪造 source / cardId 不匹配 / 超限 payload / submit 节流 / 挂起期同卡重发 /
 *  A 挂起 B 提交 / 连续 3 次拒绝关闭 / 已回复集合命中 / resize clamp / 挂起预览存活判据 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { LocalMessage } from '../../../lib/mappers'

vi.mock('../../../lib/card-registry', () => ({
  getCardIdByWindow: vi.fn(),
  getCardEntry: vi.fn(),
}))
vi.mock('../../../components/Toast', () => ({
  showToast: vi.fn(),
}))

import { useCardBridge } from './useCardBridge'
import { getCardIdByWindow, getCardEntry } from '../../../lib/card-registry'
import { showToast } from '../../../components/Toast'

const mockGetCardIdByWindow = vi.mocked(getCardIdByWindow)
const mockGetCardEntry = vi.mocked(getCardEntry)
const mockShowToast = vi.mocked(showToast)

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** 伪造的卡片 iframe contentWindow（registry 已被 mock，仅作 source 标识） */
const WIN_A = { name: 'iframe-a' } as unknown as Window
const WIN_B = { name: 'iframe-b' } as unknown as Window
const WIN_STRANGER = { name: 'stranger' } as unknown as Window

const CARD_MSG: LocalMessage = {
  id: 'msg-1', st: 'otter', si: 'otter-1', ts: '2026-07-28', dur: null,
  content: '```html-card title="卡A"\n<a/>\n```\n\n```html-card title="卡B"\n<b/>\n```',
}

function makeMessages(extra: LocalMessage[] = [], cardBody = CARD_MSG.content): LocalMessage[] {
  return [{ ...CARD_MSG, content: cardBody }, ...extra]
}

interface HookResult {
  cardPreview: { cardId: string; authorId: string; summary: string } | null
  confirmCardPreview: () => void
  rejectCardPreview: () => void
}

let hookResult: HookResult

function Harness({ messages, onSendReply }: { messages: LocalMessage[]; onSendReply: (body: string, authorId: string) => void }) {
  hookResult = useCardBridge({ activeId: 'conv-1', messages, onSendReply }) as HookResult
  return null
}

let container: HTMLDivElement
let root: Root
let onSendReply: Mock<(body: string, authorId: string) => void>
const setHeightA = vi.fn()
const setHeightB = vi.fn()

function render(messages: LocalMessage[]) {
  act(() => { root.render(<Harness messages={messages} onSendReply={onSendReply} />) })
}

/** 手动 dispatch 卡片桥消息（source 只读，defineProperty 覆盖） */
function dispatchCardMessage(source: Window, data: Record<string, unknown>) {
  const event = new MessageEvent('message', { data })
  Object.defineProperty(event, 'source', { value: source })
  act(() => { window.dispatchEvent(event) })
}

function submit(win: Window, cardId: string, payload: unknown = { summary: '选择了方案 B', data: { choice: 'B' } }) {
  dispatchCardMessage(win, { type: 'card:submit', cardId, payload })
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onSendReply = vi.fn<(body: string, authorId: string) => void>()
  setHeightA.mockClear()
  setHeightB.mockClear()
  mockShowToast.mockClear()
  mockGetCardIdByWindow.mockImplementation(w =>
    w === WIN_A ? 'msg-1:0' : w === WIN_B ? 'msg-1:1' : undefined)
  mockGetCardEntry.mockImplementation(cardId =>
    cardId === 'msg-1:0'
      ? { cardId, authorId: 'otter-1', contentWindow: WIN_A, setHeight: setHeightA }
      : cardId === 'msg-1:1'
        ? { cardId, authorId: 'otter-1', contentWindow: WIN_B, setHeight: setHeightB }
        : undefined)
  render(makeMessages())
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.useRealTimers()
})

describe('source 白名单与映射匹配', () => {
  it('伪造 source（不在 registry）的 submit 被丢弃', () => {
    submit(WIN_STRANGER, 'msg-1:0')
    expect(hookResult.cardPreview).toBeNull()
  })

  it('cardId 与 source 映射不匹配（冒充他卡）被丢弃', () => {
    // WIN_A 登记为 msg-1:0，冒充 msg-1:1
    submit(WIN_A, 'msg-1:1')
    expect(hookResult.cardPreview).toBeNull()
  })
})

describe('payload 校验闸门', () => {
  it('summary 超 500 字符被丢弃', () => {
    submit(WIN_A, 'msg-1:0', { summary: 'x'.repeat(501) })
    expect(hookResult.cardPreview).toBeNull()
  })

  it('data 超 2KB / 含函数被丢弃', () => {
    submit(WIN_A, 'msg-1:0', { summary: 'ok', data: { blob: 'x'.repeat(3000) } })
    expect(hookResult.cardPreview).toBeNull()
    vi.advanceTimersByTime(300)
    submit(WIN_A, 'msg-1:0', { summary: 'ok', data: { fn: () => 1 } })
    expect(hookResult.cardPreview).toBeNull()
  })

  it('合法 payload 进入待确认预览（含 authorId 路由目标）', () => {
    submit(WIN_A, 'msg-1:0')
    expect(hookResult.cardPreview).toMatchObject({ cardId: 'msg-1:0', authorId: 'otter-1', summary: '选择了方案 B' })
  })
})

describe('submit 节流（per-card 200ms）', () => {
  it('节流窗口内同卡第二次 submit 被丢弃，窗口外恢复', () => {
    submit(WIN_A, 'msg-1:0')
    act(() => { hookResult.rejectCardPreview() })
    // 距上次 submit 不足 200ms：被节流
    submit(WIN_A, 'msg-1:0')
    expect(hookResult.cardPreview).toBeNull()
    // 越过窗口：恢复
    vi.advanceTimersByTime(300)
    submit(WIN_A, 'msg-1:0')
    expect(hookResult.cardPreview?.cardId).toBe('msg-1:0')
  })

  it('节流按卡独立：A 节流不影响 B', () => {
    submit(WIN_A, 'msg-1:0')
    act(() => { hookResult.rejectCardPreview() })
    submit(WIN_B, 'msg-1:1', { summary: 'B 的答案' })
    expect(hookResult.cardPreview?.cardId).toBe('msg-1:1')
  })
})

describe('预览单槽位', () => {
  it('挂起期同卡重发直接丢弃（不覆盖挂起预览）', () => {
    submit(WIN_A, 'msg-1:0', { summary: '第一版' })
    vi.advanceTimersByTime(300)
    submit(WIN_A, 'msg-1:0', { summary: '第二版' })
    expect(hookResult.cardPreview?.summary).toBe('第一版')
  })

  it('A 挂起时 B 提交被拒绝并提示', () => {
    submit(WIN_A, 'msg-1:0', { summary: 'A 的提交' })
    vi.advanceTimersByTime(300)
    submit(WIN_B, 'msg-1:1', { summary: 'B 的提交' })
    expect(mockShowToast).toHaveBeenCalledWith('请先处理当前待确认的卡片提交', 'info')
    expect(hookResult.cardPreview?.cardId).toBe('msg-1:0')
  })
})

describe('连续拒绝关闭', () => {
  it('连续 3 次拒绝后该卡 submit 会话内关闭', () => {
    for (let n = 1; n <= 3; n++) {
      submit(WIN_A, 'msg-1:0')
      expect(hookResult.cardPreview?.cardId).toBe('msg-1:0')
      act(() => { hookResult.rejectCardPreview() })
      vi.advanceTimersByTime(300)
    }
    expect(mockShowToast).toHaveBeenCalledWith('该卡片提交已关闭（连续拒绝 3 次）', 'info')
    // 第 4 次：已关闭，直接丢弃
    submit(WIN_A, 'msg-1:0')
    expect(hookResult.cardPreview).toBeNull()
    // 关闭按卡独立：B 不受影响
    submit(WIN_B, 'msg-1:1')
    expect(hookResult.cardPreview?.cardId).toBe('msg-1:1')
  })
})

describe('已回复集合（历史派生）', () => {
  it('回执覆盖的 cardId 永久关闭，submit 被丢弃', () => {
    render(makeMessages([{
      id: 'r1', st: 'user', si: 'user-1', ts: '2026-07-28', dur: null,
      content: '选好了\n\n```html-card-reply card="msg-1:0"\n{"choice":"B"}\n```',
    }]))
    submit(WIN_A, 'msg-1:0')
    expect(hookResult.cardPreview).toBeNull()
    // 同消息内另一张卡不受影响
    submit(WIN_B, 'msg-1:1')
    expect(hookResult.cardPreview?.cardId).toBe('msg-1:1')
  })

  it('确认后回执进消息流：同卡再提交被已回复集合拦截', () => {
    submit(WIN_A, 'msg-1:0')
    act(() => { hookResult.confirmCardPreview() })
    expect(onSendReply).toHaveBeenCalledOnce()
    const [body, authorId] = onSendReply.mock.calls[0] as [string, string]
    expect(authorId).toBe('otter-1')
    expect(body).toContain('```html-card-reply card="msg-1:0"')
    expect(hookResult.cardPreview).toBeNull()
    // 回执消息进入 messages 后：同卡再提交被拦截（即使越过节流窗口）
    render(makeMessages([{ id: 'r1', st: 'user', si: 'user-1', ts: '2026-07-28', dur: null, content: body }]))
    vi.advanceTimersByTime(300)
    submit(WIN_A, 'msg-1:0')
    expect(hookResult.cardPreview).toBeNull()
  })
})

describe('resize 闸门', () => {
  it('高度 clamp 到 [100, 2000] 并回写登记的 setHeight', () => {
    dispatchCardMessage(WIN_A, { type: 'card:resize', cardId: 'msg-1:0', height: 99999 })
    expect(setHeightA).toHaveBeenCalledWith(2000)
    vi.advanceTimersByTime(100)
    dispatchCardMessage(WIN_A, { type: 'card:resize', cardId: 'msg-1:0', height: 1 })
    expect(setHeightA).toHaveBeenCalledWith(100)
  })

  it('resize 节流（60ms）窗口内的重复上报被丢弃；非法高度丢弃', () => {
    dispatchCardMessage(WIN_A, { type: 'card:resize', cardId: 'msg-1:0', height: 300 })
    expect(setHeightA).toHaveBeenCalledTimes(1)
    dispatchCardMessage(WIN_A, { type: 'card:resize', cardId: 'msg-1:0', height: 400 })
    expect(setHeightA).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    dispatchCardMessage(WIN_A, { type: 'card:resize', cardId: 'msg-1:0', height: 'oops' })
    expect(setHeightA).toHaveBeenCalledTimes(1)
  })
})

describe('挂起预览的存活判据（P3-7）', () => {
  it('用户收起卡片（iframe unmount / registry 注销）不丢预览：判据只看消息体围栏', () => {
    submit(WIN_A, 'msg-1:0')
    expect(hookResult.cardPreview).not.toBeNull()
    // 模拟收起：registry 中卡片注销（entry/window 均查不到）
    mockGetCardEntry.mockReturnValue(undefined)
    mockGetCardIdByWindow.mockReturnValue(undefined)
    // messages 内容不变的新引用触发重渲染 → 预览仍在
    render(makeMessages())
    expect(hookResult.cardPreview?.cardId).toBe('msg-1:0')
  })

  it('卡片围栏从消息体消失（failMessage/aborted 替换 body）→ 自动丢弃', () => {
    submit(WIN_A, 'msg-1:0')
    expect(hookResult.cardPreview).not.toBeNull()
    render(makeMessages([], '这张卡已撤销'))
    expect(hookResult.cardPreview).toBeNull()
  })

  it('fenceIndex 超出消息体内实际围栏数 → 自动丢弃', () => {
    submit(WIN_B, 'msg-1:1')
    expect(hookResult.cardPreview?.cardId).toBe('msg-1:1')
    // body 只剩 1 张卡：fenceIndex 1 不再存在
    render(makeMessages([], '```html-card title="卡A"\n<a/>\n```'))
    expect(hookResult.cardPreview).toBeNull()
  })
})
