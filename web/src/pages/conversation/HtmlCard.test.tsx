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

describe('预设类库注入（F20261006cssp）', () => {
  it('展开态 srcdoc 注入预设类 CSS 与设计 token（顺序：token 先、预设后、AI HTML 最后）', () => {
    renderCard(true)
    clickButton('展开渲染')
    const iframe = container.querySelector('iframe')
    expect(iframe).toBeTruthy()
    const doc = iframe!.getAttribute('srcdoc') || ''
    // 预设类在 srcdoc 中
    expect(doc).toContain('.topic{')
    expect(doc).toContain('.bar-fill{')
    expect(doc).toContain('.btn-primary{')
    // 顺序校验：token CSS → 预设 CSS → AI HTML
    const tokenPos = doc.indexOf('--otter-50')
    const presetPos = doc.indexOf('.topic{')
    const htmlPos = doc.indexOf('卡片内容')
    expect(tokenPos).toBeGreaterThan(-1)
    expect(presetPos).toBeGreaterThan(tokenPos)
    expect(htmlPos).toBeGreaterThan(presetPos)
  })

  it('折叠态不注入（srcdoc 为空，预设 CSS 不进 DOM）', () => {
    renderCard(true)
    const iframe = container.querySelector('iframe')
    expect(iframe).toBeFalsy()
  })
})

/** F20261013csv3 T3/T4：折叠态摘要行 + importance 默认展开 */
describe('折叠态摘要行 + importance 默认展开（F20261013csv3）', () => {
  it('importance=high 默认展开（iframe 渲染），不显示折叠态摘要行', () => {
    act(() => {
      root.render(
        <HtmlCard cardId="m:0" fenceIndex={0} title="简报" code="<p>关键结论：方案 B 最优</p>" interactive={false} authorId="o-1" importance="high" foldedSummary="关键结论：方案 B 最优" />,
      )
    })
    expect(container.querySelector('iframe'), 'high 卡默认展开').toBeTruthy()
    expect(container.textContent).toContain('简报')
  })

  it('importance 缺省（normal）默认折叠，折叠态渲染摘要行', () => {
    act(() => {
      root.render(
        <HtmlCard cardId="m:0" fenceIndex={0} title="普通卡" code="<p>摘要文本</p>" interactive={false} authorId="o-1" foldedSummary="摘要文本" />,
      )
    })
    expect(container.querySelector('iframe'), 'normal 卡默认折叠（无 iframe）').toBeNull()
    expect(container.textContent).toContain('摘要文本')
    expect(container.textContent).toContain('普通卡')
  })

  it('折叠态无摘要（foldedSummary=null）时不渲染摘要行', () => {
    act(() => {
      root.render(
        <HtmlCard cardId="m:0" fenceIndex={0} title="空摘要" code="<script>x()</script>" interactive={false} authorId="o-1" foldedSummary={null} />,
      )
    })
    expect(container.textContent).toContain('空摘要')
    // 折叠态只有标题行（无摘要 div 的 pb-2 区块）
    expect(container.querySelector('.pb-2'), '无摘要行').toBeNull()
  })
})
