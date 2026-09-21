// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RhiScoreDTO, RhiTrendsDTO, RhiOverviewDTO } from '../../api/client'
import { VerdictCard, DimensionRows, ActionList, DIMENSION_PLAIN } from './VerdictPanel'
import { SCORE_STATUS_CONFIG } from './score-status'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** issue #1029 验证：总览三层——归因句主标题、五维大白话+点开展开证据层、建议动作链到警报 */

function score(overrides: Partial<RhiScoreDTO> = {}): RhiScoreDTO {
  return {
    available: true,
    snapshotDate: '2026-09-15',
    overall: 60.6,
    overallStatus: 'yellow',
    dimensions: [
      { dimension: 'D1', name: '质量成本', score: 4.1, status: 'red' },
      { dimension: 'D2', name: '架构稳定', score: 40, status: 'yellow' },
      { dimension: 'D3', name: '交付活力', score: 96.9, status: 'green' },
      { dimension: 'D4', name: '流程合规', score: 90.8, status: 'green' },
      { dimension: 'D5', name: '信号压力', score: 91.5, status: 'green' },
    ],
    trend: { overall: 'declining', D1: 'stable', D2: 'stable', D3: 'stable', D4: 'stable', D5: 'stable' },
    attribution: '质量成本 4.1 分：bugfix 占比 39.2%（314 提交中修 bug 占比偏高）是主要拖累',
    ...overrides,
  }
}

function trends(): RhiTrendsDTO {
  return {
    days: 30,
    series: Array.from({ length: 10 }, (_, i) => ({
      date: `2026-09-0${i + 1}`,
      totalCommits: 300,
      bugfixCount: 120,
      bugfixRatio: 0.39,
      compliantCommits: 280,
    })),
    distributions: {
      changeTypes: { BugFix: 135, 'New Feature': 80, 'Feature Update': 40, Refactor: 59 },
      fileHotspots: [
        { file: 'src/app.ts', count: 44 },
        { file: 'src/platforms.ts', count: 35 },
      ],
      chainStates: { active: 28, stalled: 2, orphan: 1 },
    },
    latestSnapshotDate: '2026-09-15',
  }
}

function overview(): RhiOverviewDTO {
  return {
    metrics: { totalCommits: 314, bugfixRatio: 0.392 },
    snapshotDate: '2026-09-15',
    openSignals: 40,
    openSignalsBySeverity: { critical: 40, warning: 0 },
    openSignalsByConfidence: { normal: 40, low: 18 },
  }
}

const mounted: Root[] = []
let container: HTMLElement

function render(ui: React.ReactNode): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push(root)
  act(() => root.render(ui))
  return container
}

afterEach(() => {
  while (mounted.length) act(() => mounted.pop()!.unmount())
  container?.remove()
})

describe('第一层 VerdictCard（判断卡）', () => {
  it('归因句是第一屏主标题（不再埋在角落小字）', () => {
    const c = render(<VerdictCard score={score()} />)
    const attr = c.querySelector('[data-testid="verdict-attribution"]')
    expect(attr?.textContent).toContain('质量成本 4.1 分')
    expect(attr?.textContent).toContain('主要拖累')
  })
  it('无归因时给确定感文案', () => {
    const c = render(<VerdictCard score={score({ attribution: null })} />)
    expect(c.querySelector('[data-testid="verdict-attribution"]')?.textContent).toContain('暂无拖累')
  })
})

describe('第二层 DimensionRows（五维行 + 证据层）', () => {
  it('五维用大白话名 + 「这量在量什么」', () => {
    const c = render(<DimensionRows score={score()} trends={trends()} overview={overview()} untriagedCount={40} />)
    expect(c.textContent).toContain('修 bug 比例')
    expect(c.textContent).toContain('写新功能 vs 擦屁股的占比')
    expect(c.textContent).toContain('架构晃动')
    expect(c.textContent).toContain('交付节奏')
    expect(c.textContent).toContain('流程纪律')
    expect(c.textContent).toContain('告警处置')
  })
  it('默认展开最差的有数据维度（原型：点红色的看原因——不用自己找）', () => {
    const c = render(<DimensionRows score={score()} trends={trends()} overview={overview()} untriagedCount={40} />)
    // D1=4.1 红——默认展开
    expect(c.querySelector('[data-testid="dim-evidence-D1"]')).toBeTruthy()
    expect(c.querySelector('[data-testid="dim-row-D1"]')?.getAttribute('data-open')).toBe('1')
    // 其余默认收起
    expect(c.querySelector('[data-testid="dim-evidence-D2"]')).toBeNull()
  })
  it('点未展开的行展开证据层（D1 原料数据：bugfix 占比 + 热区清单）', () => {
    const c = render(<DimensionRows score={score()} trends={trends()} overview={overview()} untriagedCount={40} />)
    const row = c.querySelector('[data-testid="dim-row-D2"]')!
    act(() => row.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(c.querySelector('[data-testid="dim-evidence-D2"]')).toBeTruthy()
    expect(c.textContent).toContain('app.ts')
    // 再点收起
    act(() => row.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(c.querySelector('[data-testid="dim-evidence-D2"]')).toBeNull()
  })
  it('D1 证据层含近 10 天 bugfix 占比走势（健康线上方标红）', () => {
    const c = render(<DimensionRows score={score()} trends={trends()} overview={overview()} untriagedCount={40} />)
    expect(c.querySelector('[data-testid="bugfix-sparkline"]')).toBeTruthy()
    expect(c.textContent).toContain('健康线')
  })
  it('D5 证据层链到「警报」未接单数（triage 字段，F20260917trig）', () => {
    const c = render(<DimensionRows score={score()} trends={trends()} overview={overview()} untriagedCount={7} />)
    const d5 = c.querySelector('[data-testid="dim-row-D5"]')!
    act(() => d5.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(c.querySelector('[data-testid="dim-evidence-D5"]')?.textContent).toContain('去「警报」看 7 条未接单警报')
  })
})

describe('第三层 ActionList（建议动作）', () => {
  it('红/黄维度各配建议动作，链到对应 tab', () => {
    const c = render(<ActionList score={score()} untriagedCount={40} />)
    expect(c.querySelector('[data-testid="action-list"]')?.textContent).toContain('复发清单')
    expect(c.querySelector('[data-testid="evidence-action-signals"]')).toBeTruthy()
    // 全绿时给「不用动作」确定感文案
    const allGreen = score({
      overallStatus: 'green',
      dimensions: score().dimensions.map(d => ({ ...d, score: 90, status: 'green' as const })),
    })
    const c2 = render(<ActionList score={allGreen} untriagedCount={0} />)
    expect(c2.querySelector('[data-testid="action-list"]')?.textContent).toContain('都在健康线上')
  })
})

describe('文案映射单一真相源', () => {
  it('DIMENSION_PLAIN 五维齐全且 SCORE_STATUS_CONFIG 三档在位（雷达图删除后条形沿用同配色）', () => {
    for (const id of ['D1', 'D2', 'D3', 'D4', 'D5']) {
      expect(DIMENSION_PLAIN[id as keyof typeof DIMENSION_PLAIN].name.length).toBeGreaterThan(0)
      expect(DIMENSION_PLAIN[id as keyof typeof DIMENSION_PLAIN].plain.length).toBeGreaterThan(0)
    }
    expect(Object.keys(SCORE_STATUS_CONFIG)).toEqual(['green', 'yellow', 'red'])
  })
})
