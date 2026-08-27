// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { HelpIcon } from './HelpIcon'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// F20260826pfix：气泡改 Portal 挂 document.body（脱离 Modal overflow 剪裁），
// 断言范围从 container 扩大到 document.body
function renderToBody(text: string) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(<HelpIcon text={text} />) })
  const btn = container.querySelector('button')
  return { root, container, btn }
}

describe('HelpIcon', () => {
  it('点击 ? 图标应弹出说明气泡（Portal 到 body）', () => {
    const { root, container, btn } = renderToBody('等级 = 世数')
    expect(btn).not.toBeNull()

    // 气泡未显示（body 上无 tooltip）
    expect(document.body.textContent).not.toContain('等级 = 世数')

    // 点击后气泡出现（fixed 定位挂在 body 直下）
    act(() => { btn!.click() })
    expect(document.body.textContent).toContain('等级 = 世数')

    act(() => { root.unmount() })
    container.remove()
  })

  it('再次点击图标应关闭气泡', () => {
    const { root, container, btn } = renderToBody('说明文案')

    act(() => { btn!.click() })
    expect(document.body.textContent).toContain('说明文案')

    act(() => { btn!.click() })
    expect(document.body.textContent).not.toContain('说明文案')

    act(() => { root.unmount() })
    container.remove()
  })

  it('气泡应挂 body 且 fixed 定位（脱离 Modal overflow 剪裁）', () => {
    const { root, container, btn } = renderToBody('位置校验文案')

    act(() => { btn!.click() })
    const bubble = document.body.querySelector('[role="tooltip"]') as HTMLElement | null
    expect(bubble).not.toBeNull()
    expect(bubble!.className).toContain('fixed')
    // 挂在 body 直下（Portal），不在 trigger 容器内
    expect(bubble!.parentElement).toBe(document.body)

    act(() => { root.unmount() })
    container.remove()
  })

  it('按钮应带 aria-expanded / aria-describedby 可及性属性', () => {
    const { root, container, btn } = renderToBody('aria 文案')

    expect(btn!.getAttribute('aria-expanded')).toBe('false')
    act(() => { btn!.click() })
    expect(btn!.getAttribute('aria-expanded')).toBe('true')
    const describedBy = btn!.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const bubble = document.getElementById(describedBy!)
    expect(bubble).not.toBeNull()

    act(() => { root.unmount() })
    container.remove()
  })
})
