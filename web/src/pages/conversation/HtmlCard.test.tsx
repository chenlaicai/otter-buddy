// @vitest-environment jsdom
/** HtmlCard 回归测试（F20260728htar P1-2）：
 *  user 卡片（interactive=false，无桥无 registry）collapse→re-expand 不被误判为导航逃逸。
 *  修复前 loadCountRef 只在 interactive 分支内重置，重展开时二次 load 计数沿用旧值 → invalid */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { HtmlCard } from './HtmlCard'

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

function renderCard(interactive: boolean) {
  act(() => {
    root.render(
      <HtmlCard cardId="msg-1:0" fenceIndex={0} title="问卷" code="<div>卡片内容</div>" interactive={interactive} authorId="otter-1" />,
    )
  })
}

function clickButton(text: string) {
  const btn = [...container.querySelectorAll('button')].find(b => b.textContent === text)
  expect(btn, `按钮「${text}」应存在`).toBeTruthy()
  act(() => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** srcdoc iframe 在 jsdom 不自动触发 load，手动派发 */
function fireIframeLoad() {
  const iframe = container.querySelector('iframe')
  expect(iframe, '展开态应渲染 iframe').toBeTruthy()
  act(() => { iframe!.dispatchEvent(new Event('load')) })
}

describe('collapse→re-expand 回归（loadCount 进入 expanded 即重置）', () => {
  it('user 卡片（interactive=false）重展开后 load 不降级 invalid', () => {
    renderCard(false)
    clickButton('展开渲染')
    fireIframeLoad()
    expect(container.textContent).not.toContain('已失效')
    clickButton('收起')
    clickButton('展开渲染')
    fireIframeLoad()
    // 修复前：loadCount 沿用旧值 1，重展开 load 计为 2 → 误判导航逃逸
    expect(container.textContent).not.toContain('已失效')
    expect(container.textContent).toContain('沙箱渲染中')
  })

  it('otter 卡片（interactive=true）重展开后同样不降级', () => {
    renderCard(true)
    clickButton('展开渲染')
    fireIframeLoad()
    clickButton('收起')
    clickButton('展开渲染')
    fireIframeLoad()
    expect(container.textContent).not.toContain('已失效')
  })

  it('同一次展开内的二次 load 仍判定为导航逃逸（检测能力不回退）', () => {
    renderCard(false)
    clickButton('展开渲染')
    fireIframeLoad()
    fireIframeLoad()
    expect(container.textContent).toContain('已失效')
  })
})
