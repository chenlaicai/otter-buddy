// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { TrendSparkline } from './HotspotHeat'
import type { RhiTrendsDTO } from '../../api/client'

/** Issue #647 项 4：趋势图降 sparkline——首屏一行高度让位复发卡，展开后数据不丢 */

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// jsdom 无 ResizeObserver（recharts ResponsiveContainer 依赖），stub 为立即回调固定尺寸
class ResizeObserverStub {
  cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) { this.cb = cb }
  observe(el: Element): void {
    this.cb([{ target: el, contentRect: { width: 800, height: 48 } } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub

function trendsFixture(): RhiTrendsDTO {
  const series = Array.from({ length: 10 }, (_, i) => ({
    date: `2026-08-${String(20 + i).padStart(2, '0')}`,
    total_commits: i + 1,
    bugfix_ratio: 20 + i,
  }))
  return { days: 30, series, distributions: {}, latestSnapshotDate: '2026-08-29' } as unknown as RhiTrendsDTO
}

let container: HTMLElement
function render(el: React.ReactElement): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(el) })
  return container
}

describe('TrendSparkline（Issue #647 项 4）', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('默认态：卡头带 30 天 commits 合计与数据起点（消灭假空白）', () => {
    const dom = render(<TrendSparkline trends={trendsFixture()} />)
    const head = dom.querySelector('[data-testid="trend-sparkline"]')?.textContent ?? ''
    expect(head).toContain('55 commits') // 1+2+…+10
    expect(head).toContain('08/20') // x 轴从数据实际起点
  })

  it('点击展开：容器高度从 48px（sparkline）变为 220px（完整趋势），数据仍在', () => {
    const dom = render(<TrendSparkline trends={trendsFixture()} />)
    const wrapper = dom.querySelector('[data-testid="trend-sparkline"]')!.querySelector('.transition-all') as HTMLElement
    expect(wrapper.style.height).toBe('48px')
    const btn = dom.querySelector('[data-testid="trend-sparkline"] button') as HTMLButtonElement
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(wrapper.style.height).toBe('220px')
  })

  it('无序列数据不渲染', () => {
    const dom = render(<TrendSparkline trends={null} />)
    expect(dom.querySelector('[data-testid="trend-sparkline"]')).toBeNull()
  })
})
