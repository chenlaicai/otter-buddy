// @vitest-environment jsdom
/**
 * F20260831mmwh：MagicWordHelp 问号弹层测试。
 *
 * 锁定行为：
 * - 默认不展开（无 popover DOM）
 * - 点击「?」→ popover 出现，含「停下」「绕路了」两词及行为说明
 * - 再点击「?」→ popover 关闭
 * - 点击外部 → popover 关闭
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MagicWordHelp } from './MagicWordHelp'

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

function renderHelp() {
  act(() => { root.render(<MagicWordHelp />) })
  return container
}

describe('MagicWordHelp 问号弹层（F20260831mmwh）', () => {
  it('默认不展开：popover 不存在', () => {
    renderHelp()
    expect(container.querySelector('[data-testid="magic-word-popover"]')).toBeNull()
  })

  it('点击「?」按钮 → 弹出 popover，含两词及行为说明', () => {
    renderHelp()
    const btn = container.querySelector('button[aria-label="Magic Word 帮助"]') as HTMLElement
    act(() => { btn.click() })

    const popover = container.querySelector('[data-testid="magic-word-popover"]')!
    expect(popover.textContent).toContain('Magic Words')
    expect(popover.textContent).toContain('「停下」')
    expect(popover.textContent).toContain('全场急停')
    expect(popover.textContent).toContain('「绕路了」')
    expect(popover.textContent).toContain('方向重审')
  })

  it('再点击「?」按钮 → popover 关闭', () => {
    renderHelp()
    const btn = container.querySelector('button[aria-label="Magic Word 帮助"]') as HTMLElement
    act(() => { btn.click() })
    expect(container.querySelector('[data-testid="magic-word-popover"]')).not.toBeNull()
    act(() => { btn.click() })
    expect(container.querySelector('[data-testid="magic-word-popover"]')).toBeNull()
  })

  it('点击外部区域 → popover 关闭', () => {
    renderHelp()
    const btn = container.querySelector('button[aria-label="Magic Word 帮助"]') as HTMLElement
    act(() => { btn.click() })
    expect(container.querySelector('[data-testid="magic-word-popover"]')).not.toBeNull()

    // 模拟点击外部
    act(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(container.querySelector('[data-testid="magic-word-popover"]')).toBeNull()
  })

  it('popover 含 footer 提示', () => {
    renderHelp()
    const btn = container.querySelector('button[aria-label="Magic Word 帮助"]') as HTMLElement
    act(() => { btn.click() })

    const popover = container.querySelector('[data-testid="magic-word-popover"]')!
    expect(popover.textContent).toContain('海獭会立即响应')
  })

  it('aria-expanded 属性随开闭变化', () => {
    renderHelp()
    const btn = container.querySelector('button[aria-label="Magic Word 帮助"]') as HTMLButtonElement
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    act(() => { btn.click() })
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    act(() => { btn.click() })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
  })

  it('aria-haspopup 属性存在', () => {
    renderHelp()
    const btn = container.querySelector('button[aria-label="Magic Word 帮助"]') as HTMLButtonElement
    expect(btn.getAttribute('aria-haspopup')).toBe('true')
  })

  it('Esc 键关闭 popover', () => {
    renderHelp()
    const btn = container.querySelector('button[aria-label="Magic Word 帮助"]') as HTMLElement
    act(() => { btn.click() })
    expect(container.querySelector('[data-testid="magic-word-popover"]')).not.toBeNull()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('[data-testid="magic-word-popover"]')).toBeNull()
  })

  it('点击 popover 内部不关闭', () => {
    renderHelp()
    const btn = container.querySelector('button[aria-label="Magic Word 帮助"]') as HTMLElement
    act(() => { btn.click() })
    const popover = container.querySelector('[data-testid="magic-word-popover"]') as HTMLElement
    act(() => { popover.click() })
    expect(container.querySelector('[data-testid="magic-word-popover"]')).not.toBeNull()
  })
})
