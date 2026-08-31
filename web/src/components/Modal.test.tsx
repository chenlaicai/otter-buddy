// @vitest-environment jsdom
/**
 * F20260825scrf：Modal Portal + body.modal-open 生命周期测试。
 *
 * 覆盖：
 * 1. open 时 body.modal-open 挂载，close 后卸载（多重弹窗共存时不误删）
 * 2. Portal：scrim 渲染到 document.body 直下（脱离页面组件树）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

describe('Modal body.modal-open 生命周期（F20260825scrf）', () => {
  it('open 时挂载 body.modal-open，close 后移除', async () => {
    await act(async () => {
      root.render(<Modal isOpen onClose={() => {}} title="测试">内容</Modal>)
    })
    expect(document.body.classList.contains('modal-open')).toBe(true)

    await act(async () => {
      root.render(<Modal isOpen={false} onClose={() => {}} title="测试">内容</Modal>)
    })
    expect(document.body.classList.contains('modal-open')).toBe(false)
  })

  it('多重弹窗共存：一个关闭不误删 class，全部关闭才移除', async () => {
    await act(async () => {
      root.render(
        <>
          <Modal isOpen onClose={() => {}} title="A">A</Modal>
          <Modal isOpen onClose={() => {}} title="B">B</Modal>
        </>
      )
    })
    expect(document.body.classList.contains('modal-open')).toBe(true)

    await act(async () => {
      root.render(
        <>
          <Modal isOpen={false} onClose={() => {}} title="A">A</Modal>
          <Modal isOpen onClose={() => {}} title="B">B</Modal>
        </>
      )
    })
    // 仍有一个 scrim 存留，class 不应被移除
    expect(document.body.classList.contains('modal-open')).toBe(true)

    await act(async () => {
      root.render(
        <>
          <Modal isOpen={false} onClose={() => {}} title="A">A</Modal>
          <Modal isOpen={false} onClose={() => {}} title="B">B</Modal>
        </>
      )
    })
    expect(document.body.classList.contains('modal-open')).toBe(false)
  })

  it('Portal：scrim 渲染在 document.body 直下，不在页面容器内', async () => {
    await act(async () => {
      root.render(<Modal isOpen onClose={() => {}} title="测试">内容</Modal>)
    })
    const scrim = document.querySelector('body > .scrim')
    expect(scrim).not.toBeNull()
    expect(container.contains(scrim)).toBe(false)
  })
})

describe('Modal maxHeight 恒给（F20260831wsui）', () => {
  it('dialog 层 maxHeight 恒为 --modal-scroll-max-h（无论 fullScreenOnMobile）', async () => {
    await act(async () => {
      root.render(
        <Modal isOpen onClose={() => {}} title="测试" fullScreenOnMobile>
          内容
        </Modal>
      )
    })
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog).not.toBeNull()
    expect(dialog.style.maxHeight).toBe('var(--modal-scroll-max-h)')
  })

  it('content 层 maxHeight 恒为 --modal-content-max-h（无论 fullScreenOnMobile）', async () => {
    await act(async () => {
      root.render(
        <Modal isOpen onClose={() => {}} title="测试" fullScreenOnMobile>
          内容
        </Modal>
      )
    })
    // content 层是 dialog 内的 overflow-y-auto div
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const content = dialog.querySelector('.overflow-y-auto') as HTMLElement
    expect(content).not.toBeNull()
    expect(content.style.maxHeight).toBe('var(--modal-content-max-h)')
  })

  it('非 fullScreenOnMobile 时 maxHeight 同样恒给', async () => {
    await act(async () => {
      root.render(
        <Modal isOpen onClose={() => {}} title="测试">
          内容
        </Modal>
      )
    })
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog.style.maxHeight).toBe('var(--modal-scroll-max-h)')
  })
})
