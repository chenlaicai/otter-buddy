// @vitest-environment jsdom
/**
 * F20260916ment：MessageInput @提及显式 ID 通道测试（Slack 结构化提及模式）。
 *
 * 锁定行为：
 * 1. 弹层选中 → 发送时走 pickedMentions 显式 ID（不再从文本反解析）
 * 2. 选中后删除文本里的 @名字 → 该选中项自动失效（防幽灵目标）
 * 3. 手打未走弹层的 @名字 → 文本解析降级通道兜底（词边界规则）
 * 4. 词边界：「在@功能」类紧贴前字的 @ 不进入提及集合
 */
import { describe, it, expect, vi } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
import { MessageInput } from './MessageInput'
import type { Otter } from '../../lib/types'
import type { StagedAttachment, UploadErrorInfo } from './hooks/useAttachmentStaging'

// jsdom 下中文 value 经 fireEvent 会被 TextEncoder 截断（@大 → @），
// 组件测试用英文獭名；中文词边界由服务端 mention-parser 单测覆盖（NFC/中文标点用例齐全）。
const OTTERS = [
  { id: 'id-big', name: 'Alice' },
  { id: 'id-talk', name: 'Bob' },
] as unknown as Otter[]

function renderInput(overrides?: Partial<Parameters<typeof MessageInput>[0]>) {
  const onSend = vi.fn()
  const props = {
    onSend,
    disabled: false,
    otters: OTTERS,
    conversationId: 'conv-mention',
    staged: [] as StagedAttachment[],
    onRemoveAttachment: vi.fn(),
    onPickFiles: vi.fn(),
    uploadError: null as UploadErrorInfo | null,
    onDismissUploadError: vi.fn(),
    ...overrides,
  }
  const utils = render(<MessageInput {...props} />)
  const textarea = utils.container.querySelector('textarea')! as HTMLTextAreaElement
  return { ...utils, textarea, onSend }
}

/** 模拟输入：React onChange 走合成事件（原生 input 事件不触发），fireEvent.change 正确设值 */
function typeText(textarea: HTMLTextAreaElement, value: string) {
  act(() => {
    fireEvent.change(textarea, { target: { value } })
    textarea.setSelectionRange(value.length, value.length)
  })
}

function sendNow(textarea: HTMLTextAreaElement) {
  act(() => {
    fireEvent.keyDown(textarea, { key: 'Enter' })
  })
}

describe('F20260916ment：@提及显式 ID 通道', () => {
  it('弹层选中 → 发送携带显式 ID', () => {
    const { container, textarea, onSend } = renderInput()
    typeText(textarea, '@Al')
    // 弹层出现，点击「大獭」（React onClick 不在 DOM onclick 属性上——用 fireEvent）
    const item = Array.from(container.querySelectorAll('div')).find(el => el.textContent?.includes('Alice') && el.className.includes('cursor-pointer'))
    expect(item).toBeTruthy()
    fireEvent.click(item as HTMLElement)
    expect(textarea.value).toBe('@Alice ')
    sendNow(textarea)
    expect(onSend).toHaveBeenCalledTimes(1)
    const [text, ids] = onSend.mock.calls[0]!
    expect(text).toBe('@Alice ')
    expect(ids).toEqual(['id-big'])
  })

  it('选中后删掉 @名字 → 目标自动失效（防幽灵目标）', () => {
    const { container, textarea, onSend } = renderInput()
    typeText(textarea, '@Bo')
    const item = Array.from(container.querySelectorAll('div')).find(el => el.textContent?.includes('Bob') && el.className.includes('cursor-pointer'))
    fireEvent.click(item as HTMLElement)
    expect(textarea.value).toBe('@Bob ')
    // 用户把 @话獭 删了，改成普通文本
    typeText(textarea, '算了不问了')
    sendNow(textarea)
    const [, ids] = onSend.mock.calls[0]!
    expect(ids).toBeUndefined()
  })

  it('手打未走弹层（词边界内）→ 文本解析降级通道', () => {
    const { textarea, onSend } = renderInput()
    // 直接整段输入（@大獭 前是行首，词边界内）
    typeText(textarea, '@Alice 看一下')
    sendNow(textarea)
    const [, ids] = onSend.mock.calls[0]!
    expect(ids).toEqual(['id-big'])
  })

  it('词边界外（在@功能）→ 不进入提及集合，走默认派发', () => {
    const { textarea, onSend } = renderInput()
    typeText(textarea, 'npm i openclaw-cli@latest 试试')
    sendNow(textarea)
    const [, ids] = onSend.mock.calls[0]!
    expect(ids).toBeUndefined()
  })

  it('紧贴前字的 @名字（问一下@大獭）→ 不点名（词边界规则既定代价）', () => {
    const { textarea, onSend } = renderInput()
    typeText(textarea, '问一下@Alice。')
    sendNow(textarea)
    const [, ids] = onSend.mock.calls[0]!
    expect(ids).toBeUndefined()
  })
})
