// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

// 页面入口（./index.tsx）在 import 时挂载全页，测试环境需先建容器（同 TrendIcon.test.tsx 先例）
document.body.innerHTML = '<div id="root"></div>'

const { RecurrenceCard, RecurrencePanel, LowConfidenceDrawer, HotspotHeatBar, TrendSparkline, isRecurrenceSignal, timelineNodes, heatColor, changeTypeNodeColor } = await import('./recurrence')
import type { RhiSignalDTO } from '../../api/client'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

function render(el: React.ReactNode): HTMLElement {
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => { root.render(el) })
  return container
}

/** bug_recurrence 信号 fixture：evidenceDetail 带交替 changeType 的 commit 序列 */
function recurrenceSignal(overrides: Partial<RhiSignalDTO> = {}): RhiSignalDTO {
  return {
    id: 1,
    signal_type: 'bug_recurrence',
    severity: 'critical',
    feature_id: null,
    file_path: 'src/usecases/health/health-score.ts',
    evidence: 'e',
    first_seen: '2026-08-20T00:00:00.000Z',
    last_seen: '2026-08-29T00:00:00.000Z',
    occurrences: 99, // 扫描 99 次（漂移指标）——徽章禁止用它
    status: 'open',
    suggested_action: '强制根因分析',
    signalTypeLabel: 'bug 反复出现',
    evidenceDetail: {
      kind: 'bug_recurrence_commits',
      windowDays: 30,
      commits: [
        { sha: 'aaa11111', date: '2026-08-18T00:00:00.000Z', changeType: 'New Feature', message: '引入' },
        { sha: 'bbb22222', date: '2026-08-20T00:00:00.000Z', changeType: 'BugFix', message: '修1' },
        { sha: 'ccc33333', date: '2026-08-23T00:00:00.000Z', changeType: 'BugFix', message: '修2' },
        { sha: 'ddd44444', date: '2026-08-26T00:00:00.000Z', changeType: 'New Feature', message: '迭代' },
        { sha: 'eee55555', date: '2026-08-29T00:00:00.000Z', changeType: 'BugFix', message: '修3' },
      ],
    },
    confidence: null,
    ...overrides,
  }
}

function lowSignal(id: number): RhiSignalDTO {
  return {
    id,
    signal_type: 'chain_stall',
    severity: 'critical',
    feature_id: 'F20260801xxxx',
    file_path: null,
    evidence: '滞留 20 天无 commit',
    first_seen: '2026-08-01T00:00:00.000Z',
    last_seen: '2026-08-29T00:00:00.000Z',
    occurrences: 5,
    status: 'open',
    suggested_action: '链复盘',
    signalTypeLabel: '特性链滞留',
    evidenceDetail: null,
    confidence: 'low',
  }
}

describe('isRecurrenceSignal（复发信号判定）', () => {
  it('bug_recurrence 与 post_merge_fix_density 均为复发卡素材', () => {
    expect(isRecurrenceSignal(recurrenceSignal())).toBe(true)
    expect(isRecurrenceSignal(recurrenceSignal({ signal_type: 'post_merge_fix_density', severity: 'warning' }))).toBe(true)
    expect(isRecurrenceSignal(lowSignal(2))).toBe(false)
    expect(isRecurrenceSignal(recurrenceSignal({ signal_type: 'hotspot', severity: 'warning' }))).toBe(false)
  })
})

describe('RecurrenceCard（复发模式卡，Issue #647 验收）', () => {
  it('时间轴渲染交替 changeType：bug（caramel）与 fix（teal）节点都存在', () => {
    const c = render(<RecurrenceCard signal={recurrenceSignal()} />)
    const nodes = c.querySelectorAll('span.rounded-full.ring-2')
    expect(nodes.length).toBe(5)
    const colors = [...nodes].map(n => (n as HTMLElement).style.backgroundColor)
    // BugFix=teal #3A8B8B（3 个），New Feature=caramel #C9956B（2 个）
    expect(colors.filter(x => x === 'rgb(58, 139, 139)').length).toBe(3)
    expect(colors.filter(x => x === 'rgb(201, 149, 107)').length).toBe(2)
  })

  it('频次徽章从 evidenceDetail.commits 派生（3 次 BugFix），禁用 occurrences（99 次扫描）', () => {
    const c = render(<RecurrenceCard signal={recurrenceSignal()} />)
    const badge = c.querySelector('span.rounded-full.bg-caramel-600')
    expect(badge?.textContent).toContain('3 次')
    expect(badge?.textContent).not.toContain('99')
  })

  it('修复密度信号：占比与排除清单可见（不黑箱，验收项）', () => {
    const sig = recurrenceSignal({
      signal_type: 'post_merge_fix_density',
      severity: 'warning',
      file_path: null,
      feature_id: 'F20260901xxxx',
      evidenceDetail: {
        kind: 'post_merge_fix_density',
        windowDays: 14,
        commits: [],
        fixCommits: [
          { sha: 'aaa11111', date: '2026-08-18T00:00:00.000Z', changeType: 'BugFix', message: '修1' },
          { sha: 'bbb22222', date: '2026-08-20T00:00:00.000Z', changeType: 'BugFix', message: '修2' },
          { sha: 'ccc33333', date: '2026-08-23T00:00:00.000Z', changeType: 'BugFix', message: '修3' },
        ],
        totalRelatedCommits: 7,
        fixRatio: 0.4286,
        excludedHighFaninFiles: ['src/app.ts', 'web/src/pages/index.tsx'],
      },
    })
    const c = render(<RecurrenceCard signal={sig} />)
    const text = c.textContent ?? ''
    expect(text).toContain('占比 43%')
    expect(text).toContain('相关 7 commit')
    expect(text).toContain('已排除高扇入文件 2 个')
  })

  it('evidenceDetail 缺失时降级：显示 evidence 文本不崩，徽章退回 occurrences', () => {
    const c = render(<RecurrenceCard signal={recurrenceSignal({ evidenceDetail: null })} />)
    expect(c.textContent).toContain('e')
    const badge = c.querySelector('span.rounded-full.bg-caramel-600')
    expect(badge?.textContent).toContain('99')
  })
})

describe('RecurrencePanel（复发区容器）', () => {
  it('空态显示「无复发模式」确定感（非留白）', () => {
    const c = render(<RecurrencePanel signals={[lowSignal(1)]} />)
    expect(c.textContent).toContain('无复发模式')
  })

  it('超过 5 张卡折叠计数提示', () => {
    const many = Array.from({ length: 7 }, (_, i) => recurrenceSignal({ id: i + 1 }))
    const c = render(<RecurrencePanel signals={many} />)
    expect(c.querySelectorAll('.rounded-2xl.bg-white\\/80').length).toBe(5)
    expect(c.textContent).toContain('其余 2 个')
  })
})

describe('LowConfidenceDrawer（低置信折叠抽屉，Issue #647 验收）', () => {
  it('默认折叠：低置信计数可见但明细不展开', () => {
    const c = render(<LowConfidenceDrawer signals={[lowSignal(1), lowSignal(2), lowSignal(3)]} />)
    expect(c.textContent).toContain('3')
    expect(c.textContent).not.toContain('滞留 20 天')
  })

  it('点击展开后明细可见（数据不丢）', () => {
    const c = render(<LowConfidenceDrawer signals={[lowSignal(1), lowSignal(2)]} />)
    const btn = c.querySelector('button')!
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(c.textContent).toContain('滞留 20 天')
    // 低置信徽章降级：描边样式（border）而非实心
    const badge = c.querySelector('span.border')
    expect(badge?.className).toContain('border-caramel-400')
  })

  it('无低置信信号时整个抽屉不渲染', () => {
    const c = render(<LowConfidenceDrawer signals={[recurrenceSignal()]} />)
    expect(c.children.length).toBe(0)
  })
})

describe('HotspotHeatBar（热点热力条）', () => {
  it('teal→caramel 热力映射：频次高者颜色更热，最热=caramel 最冷≈teal', () => {
    const c = render(<HotspotHeatBar files={[
      { file: 'src/hot.ts', count: 10 },
      { file: 'src/warm.ts', count: 5 },
      { file: 'src/cold.ts', count: 1 },
    ]} />)
    const bars = [...c.querySelectorAll('.h-full.rounded-full')] as HTMLElement[]
    expect(bars.length).toBe(3)
    // 最热（ratio=1）= caramel-500
    expect(bars[0]!.style.backgroundColor).toBe('rgb(201, 149, 107)')
    // 最冷（ratio=0.1）= teal↔caramel 插值（介于两者之间，偏 teal 侧）
    const cold = bars[2]!.style.backgroundColor
    expect(cold).not.toBe('rgb(201, 149, 107)')
    // 文件名以等宽字体渲染
    expect(c.querySelector('.font-mono')?.textContent).toContain('src/hot.ts')
  })
})

describe('TrendSparkline（趋势降级）', () => {
  it('渲染一行高度 SVG 折线 + 末值百分比', () => {
    const c = render(<TrendSparkline series={[
      { date: '2026-08-25', bugfix_ratio: 0.2, total_commits: 10 },
      { date: '2026-08-26', bugfix_ratio: 0.25, total_commits: 12 },
      { date: '2026-08-27', bugfix_ratio: 0.3, total_commits: 8 },
    ]} />)
    expect(c.querySelector('svg')).toBeTruthy()
    expect(c.textContent).toContain('30.0%')
    expect(c.textContent).toContain('近 3 天')
  })

  it('空数据显示占位文案', () => {
    const c = render(<TrendSparkline series={[]} />)
    expect(c.textContent).toContain('无趋势数据')
  })
})

describe('色彩 token（视觉方案 3.4 纪律）', () => {
  it('changeTypeNodeColor：BugFix=teal，非 BugFix=caramel（红不参与中性标注）', () => {
    expect(changeTypeNodeColor('BugFix')).toBe('#3A8B8B')
    expect(changeTypeNodeColor('New Feature')).toBe('#C9956B')
    expect(changeTypeNodeColor(null)).toBe('#C9956B')
  })

  it('heatColor：0=teal-500，1=caramel-500，单调插值', () => {
    expect(heatColor(0)).toBe('#3a8b8b')
    expect(heatColor(1)).toBe('#c9956b')
    expect(heatColor(-1)).toBe('#3a8b8b')
    expect(heatColor(2)).toBe('#c9956b')
  })
})

describe('timelineNodes（时间轴节点映射）', () => {
  it('节点按日期映射百分比，首尾对齐', () => {
    const nodes = timelineNodes(recurrenceSignal())
    expect(nodes.length).toBe(5)
    expect(nodes[0]!.pct).toBe(0)
    expect(nodes[nodes.length - 1]!.pct).toBe(100)
    // 中间节点升序
    expect(nodes[1]!.pct).toBeGreaterThan(0)
    expect(nodes[1]!.pct).toBeLessThan(100)
  })
})
