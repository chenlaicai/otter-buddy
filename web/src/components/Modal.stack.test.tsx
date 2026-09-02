// @vitest-environment jsdom
/**
 * #510（F20260901mftz）：多 Modal 叠加 focus trap 栈测试。
 *
 * 覆盖：
 * 1. 叠加时 Escape 只关栈顶（次层不响应）——原先两实例都挂 keydown 会连锁关闭
 * 2. 叠加时 Tab 循环由栈顶接管（次层 trap 静默）——原先两个 trap 互相拉扯
 * 3. 栈顶关闭后次层恢复接管
 * 4. 全部关闭后 body.modal-open 移除（既有行为不回归）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Modal } from './Modal'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  document.body.classList.remove('modal-open')
  document.body.innerHTML = ''
})

/** 模拟一次键盘事件（KeyboardEvent 构造在 jsdom 可用） */
function pressKey(key: 'Escape' | 'Tab', shiftKey = false) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, shiftKey }))
}

/** 渲染两个叠加的 Modal（outer 内开 inner 场景的抽象） */
function renderStacked(outerClose: () => void, innerClose: () => void) {
  act(() => {
    root.render(
      <>
        <Modal isOpen onClose={outerClose} title="外层">
          <input aria-label="外层输入" />
        </Modal>
        <Modal isOpen onClose={innerClose} title="内层">
          <input aria-label="内层输入" />
        </Modal>
      </>
    )
  })
}

describe('多 Modal 叠加 focus trap 栈（#510）', () => {
  it('叠加时 Escape 只关栈顶，次层不受影响', async () => {
    const outerClose = vi.fn()
    const innerClose = vi.fn()
    renderStacked(outerClose, innerClose)

    pressKey('Escape')
    expect(innerClose).toHaveBeenCalledTimes(1)
    expect(outerClose).not.toHaveBeenCalled()
  })

  it('叠加时 Tab 循环限制在栈顶 dialog 内（焦点不落入次层元素）', async () => {
    const outerClose = vi.fn()
    const innerClose = vi.fn()
    renderStacked(outerClose, innerClose)

    const dialogs = document.querySelectorAll('div[role="dialog"]')
    expect(dialogs.length).toBe(2)
    const innerDialog = dialogs[1] // Portal 顺序 = 挂载顺序
    const innerFocusables = Array.from(
      innerDialog.querySelectorAll<HTMLElement>('button, input'),
    )

    // 焦点初始在内层关闭按钮（打开即聚焦）
    expect(document.activeElement).toBe(innerFocusables[0])

    // Tab 走到内层最后一个可聚焦元素后再 Tab → 循环回内层第一个
    innerFocusables[innerFocusables.length - 1].focus()
    pressKey('Tab')
    expect(document.activeElement).toBe(innerFocusables[0])
  })

  it('栈顶关闭后次层恢复接管（Escape 关次层）', async () => {
    const outerClose = vi.fn()
    const innerClose = vi.fn()
    renderStacked(outerClose, innerClose)

    // 关闭内层（模拟）
    await act(async () => {
      root.render(
        <Modal isOpen onClose={outerClose} title="外层">
          <input aria-label="外层输入" />
        </Modal>,
      )
    })

    pressKey('Escape')
    expect(outerClose).toHaveBeenCalledTimes(1)
  })

  it('叠加共存期 body.modal-open 保持，全部关闭才移除（既有行为）', async () => {
    const outerClose = vi.fn()
    const innerClose = vi.fn()
    renderStacked(outerClose, innerClose)
    expect(document.body.classList.contains('modal-open')).toBe(true)

    // 关闭内层——外层仍在，class 不移除
    await act(async () => {
      root.render(
        <Modal isOpen onClose={outerClose} title="外层">
          <input aria-label="外层输入" />
        </Modal>,
      )
    })
    expect(document.body.classList.contains('modal-open')).toBe(true)

    // 全部关闭——class 移除
    await act(async () => {
      root.render(<Modal isOpen={false} onClose={outerClose} title="外层">x</Modal>)
    })
    expect(document.body.classList.contains('modal-open')).toBe(false)
  })
})
