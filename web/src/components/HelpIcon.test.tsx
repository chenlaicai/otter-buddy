// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { HelpIcon } from './HelpIcon'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

describe('HelpIcon', () => {
  it('点击 ? 图标应弹出说明气泡', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => { root.render(<HelpIcon text="等级 = 世数" />) })
    const btn = container.querySelector('button')
    expect(btn).not.toBeNull()

    // 气泡未显示
    expect(container.textContent).not.toContain('等级 = 世数')

    // 点击后气泡出现
    act(() => { btn!.click() })
    expect(container.textContent).toContain('等级 = 世数')

    act(() => { root.unmount() })
    container.remove()
  })

  it('再次点击图标应关闭气泡', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => { root.render(<HelpIcon text="说明文案" />) })
    const btn = container.querySelector('button')!

    act(() => { btn.click() })
    expect(container.textContent).toContain('说明文案')

    act(() => { btn.click() })
    expect(container.textContent).not.toContain('说明文案')

    act(() => { root.unmount() })
    container.remove()
  })
})
