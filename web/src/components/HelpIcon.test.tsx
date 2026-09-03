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

// F20260903：text 放宽为 ReactNode——健康页五维雷达公式列表是结构化内容
describe('HelpIcon ReactNode 内容（F20260903）', () => {
  it('接受结构化 JSX 内容并完整渲染在 Portal 气泡中', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(
        <HelpIcon text={(
          <div>
            <p>综合分 = Σ(维度分 × 权重) / Σ(有数据维度权重)</p>
            <div>维度公式行</div>
          </div>
        )} />
      )
    })
    const btn = container.querySelector('button')
    expect(btn).not.toBeNull()
    expect(document.body.textContent).not.toContain('综合分')

    act(() => { btn!.click() })
    const bubble = document.body.querySelector('[role="tooltip"]')
    expect(bubble).not.toBeNull()
    expect(bubble!.textContent).toContain('综合分 = Σ(维度分 × 权重)')
    expect(bubble!.textContent).toContain('维度公式行')

    act(() => { root.unmount() })
    container.remove()
  })
})
