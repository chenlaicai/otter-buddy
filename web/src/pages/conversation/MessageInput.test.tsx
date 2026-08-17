// @vitest-environment jsdom
/** MessageInput 多 @mention 解析测试。
 *  验证：多个 @mention → 数组传递；单 @mention 兼容；无效 @mention 过滤；无 @mention → undefined */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { LocalOtter as Otter } from '../../lib/mappers'
import { MessageInput } from './MessageInput'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const OTTERS: Otter[] = [
  { id: 'otter-a', name: '獭A', type: 'small', createdAt: '2026-01-01' },
  { id: 'otter-b', name: '獭B', type: 'small', createdAt: '2026-01-01' },
  { id: 'otter-c', name: '獭C', type: 'big', createdAt: '2026-01-01' },
]

let container: HTMLDivElement
let root: Root
let onSend: ReturnType<typeof vi.fn<(text: string, mentionOtterIds?: string[]) => void>>

function render(otters: Otter[] = OTTERS) {
  act(() => {
    root.render(<MessageInput onSend={onSend} disabled={false} otters={otters} />)
  })
}

function getTextarea(): HTMLTextAreaElement {
  return container.querySelector('textarea')!
}

function typeText(text: string) {
  const textarea = getTextarea()
  // React 受控组件：需同时设 value 和触发 onChange
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype, 'value'
  )!.set!
  act(() => {
    nativeInputValueSetter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function pressEnter() {
  act(() => {
    getTextarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onSend = vi.fn()
  render()
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('多 @mention 解析', () => {
  it('两个 @mention → 传递两个 otter ID 的数组', () => {
    typeText('@獭A @獭B 请做XX')
    pressEnter()
    expect(onSend).toHaveBeenCalledOnce()
    expect(onSend).toHaveBeenCalledWith('@獭A @獭B 请做XX', ['otter-a', 'otter-b'])
  })

  it('三个 @mention → 传递三个 ID', () => {
    typeText('@獭A @獭B @獭C 全员出动')
    pressEnter()
    expect(onSend).toHaveBeenCalledWith('@獭A @獭B @獭C 全员出动', ['otter-a', 'otter-b', 'otter-c'])
  })

  it('单个 @mention → 兼容：传递包含一个元素的数组', () => {
    typeText('@獭A 做XX')
    pressEnter()
    expect(onSend).toHaveBeenCalledWith('@獭A 做XX', ['otter-a'])
  })

  it('无 @mention → 第二个参数为 undefined', () => {
    typeText('普通消息')
    pressEnter()
    expect(onSend).toHaveBeenCalledWith('普通消息', undefined)
  })

  it('无效 @mention（不在 otters 列表中）→ 过滤掉', () => {
    typeText('@不存在 @獭A 做XX')
    pressEnter()
    expect(onSend).toHaveBeenCalledWith('@不存在 @獭A 做XX', ['otter-a'])
  })

  it('全部无效 @mention → 第二个参数为 undefined', () => {
    typeText('@不存在1 @不存在2 做XX')
    pressEnter()
    expect(onSend).toHaveBeenCalledWith('@不存在1 @不存在2 做XX', undefined)
  })

  it('@mention 在消息中间和末尾也能正确解析', () => {
    typeText('请 @獭A 和 @獭B 一起做')
    pressEnter()
    expect(onSend).toHaveBeenCalledWith('请 @獭A 和 @獭B 一起做', ['otter-a', 'otter-b'])
  })
})

describe('disabled 状态', () => {
  it('disabled 时不调用 onSend', () => {
    act(() => { root.unmount() })
    root = createRoot(container)
    act(() => {
      root.render(<MessageInput onSend={onSend} disabled={true} otters={OTTERS} />)
    })
    typeText('@獭A @獭B 做XX')
    pressEnter()
    expect(onSend).not.toHaveBeenCalled()
  })
})

describe('空白消息', () => {
  it('纯空白不发送', () => {
    typeText('   ')
    pressEnter()
    expect(onSend).not.toHaveBeenCalled()
  })
})
