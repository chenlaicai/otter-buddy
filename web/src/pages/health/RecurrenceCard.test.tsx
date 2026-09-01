// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { RhiSignalDTO } from '../../api/client'
import { RecurrenceSection, toRecurrenceCard, LowConfidenceDrawer, FreqBadge, FanInExcludedList } from './RecurrenceCard'
import { HotspotHeatBar, hotspotData } from './HotspotHeat'
import type { RhiTrendsDTO } from '../../api/client'

// 页面入口 index.tsx 在 import 时挂载 #root，本测试不 import 它，无副作用
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

function recurrenceSignal(overrides: Partial<RhiSignalDTO> = {}): RhiSignalDTO {
  return {
    id: 1,
    signal_type: 'bug_recurrence',
    severity: 'critical',
    feature_id: null,
    file_path: 'src/health/health-score.ts',
    evidence: 'evidence text',
    first_seen: '2026-08-20T00:00:00Z',
    last_seen: '2026-08-30T00:00:00Z',
    occurrences: 99, // 严禁使用的假频次源——测试确保 UI 不读它
    status: 'open',
    suggested_action: 's',
    signalTypeLabel: 'bug 反复出现',
    evidenceDetail: {
      kind: 'bug_recurrence_commits',
      windowDays: 30,
      commits: [
        { sha: 'a1', date: '2026-08-10T00:00:00Z', changeType: 'BugFix', message: 'fix 1' },
        { sha: 'a2', date: '2026-08-15T00:00:00Z', changeType: 'New Feature', message: 'feat' },
        { sha: 'a3', date: '2026-08-20T00:00:00Z', changeType: 'BugFix', message: 'fix 2' },
      ],
    },
    confidence: null,
    ...overrides,
  }
}

function stallSignal(overrides: Partial<RhiSignalDTO> = {}): RhiSignalDTO {
  return {
    id: 100,
    signal_type: 'chain_stall',
    severity: 'critical',
    feature_id: 'F20260901xstall',
    file_path: null,
    evidence: '滞留 20 天',
    first_seen: '2026-08-20T00:00:00Z',
    last_seen: '2026-08-30T00:00:00Z',
    occurrences: 3,
    status: 'open',
    suggested_action: 's',
    signalTypeLabel: '特性链滞留',
    evidenceDetail: null,
    confidence: 'low',
    ...overrides,
  }
}

let container: HTMLElement
let root: ReturnType<typeof createRoot>
function render(el: React.ReactElement): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(el) })
  return container
}

describe('复发模式卡（Issue #647 项 1）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('频次徽章从 commits.length 派生，不读 occurrences（合议明令）', () => {
    const card = toRecurrenceCard(recurrenceSignal())!
    expect(card.commitCount).toBe(3)
    expect(card.commitCount).not.toBe(99)
    const dom = render(<RecurrenceSection signals={[recurrenceSignal()]} />)
    const badge = dom.querySelector('[data-testid="recurrence-badge"]')
    expect(badge?.textContent).toContain('3 次')
    expect(badge?.textContent).not.toContain('99')
  })

  it('时间轴渲染交替 changeType：3 节点含 bug 与 feat 标签（验收项）', () => {
    const dom = render(<RecurrenceSection signals={[recurrenceSignal()]} />)
    const timeline = dom.querySelector('[data-testid="recurrence-timeline"]')
    expect(timeline).not.toBeNull()
    // bug→feat→bug 交替节奏在节点标签中可见
    const labels = [...dom.querySelectorAll('[data-testid="recurrence-timeline"] span')].map(s => s.textContent)
    expect(labels.filter(t => t === 'bug').length).toBe(2)
    expect(labels.filter(t => t === 'feat').length).toBe(1)
  })

  it('无复发模式时显示确定感空态', () => {
    const dom = render(<RecurrenceSection signals={[]} />)
    expect(dom.querySelector('[data-testid="recurrence-empty"]')?.textContent).toContain('无复发模式')
  })

  it('evidenceDetail 缺失的 bug_recurrence 信号不渲染卡片（无米不下锅）', () => {
    const s = recurrenceSignal({ evidenceDetail: null })
    expect(toRecurrenceCard(s)).toBeNull()
  })
})

describe('低置信折叠抽屉（Issue #647 项 2 / #652）', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('默认收起：列表不可见，仅标题行（验收项）', () => {
    const dom = render(<LowConfidenceDrawer signals={[stallSignal(), stallSignal({ id: 101, feature_id: 'F2' })]} />)
    expect(dom.querySelector('[data-testid="low-confidence-drawer"]')).not.toBeNull()
    expect(dom.querySelector('[data-testid="low-confidence-toggle"]')?.textContent).toContain('2')
    expect(dom.querySelector('[data-testid="low-confidence-list"]')).toBeNull()
  })

  it('点击展开后明细可见，数据不丢', () => {
    const dom = render(<LowConfidenceDrawer signals={[stallSignal()]} />)
    const toggle = dom.querySelector('[data-testid="low-confidence-toggle"]') as HTMLButtonElement
    act(() => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const list = dom.querySelector('[data-testid="low-confidence-list"]')
    expect(list).not.toBeNull()
    expect(list?.textContent).toContain('F20260901xstall')
  })

  it('空列表不渲染抽屉', () => {
    const dom = render(<LowConfidenceDrawer signals={[]} />)
    expect(dom.querySelector('[data-testid="low-confidence-drawer"]')).toBeNull()
  })
})

describe('热点热力条（Issue #647 项 3）', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('渲染频次与文件名，teal→caramel 色阶容器存在', () => {
    const dom = render(<HotspotHeatBar hotspots={[{ file: 'src/health/health-score.ts', count: 5 }, { file: 'src/a.ts', count: 2 }]} />)
    const bar = dom.querySelector('[data-testid="hotspot-heat-bar"]')
    expect(bar?.textContent).toContain('5 次')
    expect(bar?.textContent).toContain('health-score.ts')
  })

  it('从 trends DTO 提取 30 天热点', () => {
    const trends = { distributions: { file_hotspots: [{ file: 'a.ts', count: 4 }, { file: 'b.ts', count: 9 }] } } as unknown as RhiTrendsDTO
    const data = hotspotData(trends)
    expect(data[0]!.file).toBe('b.ts') // 降序
  })
})

describe('信号频次徽章（检视建议 5：频次口径收口）', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('bug_recurrence 走证据序列长度，不读 occurrences（fixture occurrences=99 不得出现）', () => {
    const dom = render(<FreqBadge signal={recurrenceSignal()} />)
    const badge = dom.querySelector('[data-testid="freq-badge"]')
    expect(badge?.textContent).toContain('复发 3 次')
    expect(dom.textContent).not.toContain('99')
  })

  it('bug_recurrence 单条证据序列（1 commit）不渲染徽章', () => {
    const s = recurrenceSignal({
      evidenceDetail: {
        kind: 'bug_recurrence_commits',
        windowDays: 30,
        commits: [{ sha: 'c1', date: '2026-08-25T00:00:00Z', changeType: 'BugFix', message: 'fix' }],
      },
    })
    const dom = render(<FreqBadge signal={s} />)
    expect(dom.querySelector('[data-testid="freq-badge"]')).toBeNull()
  })

  it('无 evidenceDetail 的 bug_recurrence 不渲染徽章（防御：无证据不显示频次）', () => {
    const dom = render(<FreqBadge signal={recurrenceSignal({ evidenceDetail: null })} />)
    expect(dom.querySelector('[data-testid="freq-badge"]')).toBeNull()
  })

  it('非复发信号保留 occurrences 口径（chain_stall occurrences=3 → 复发 3 次）', () => {
    const dom = render(<FreqBadge signal={stallSignal()} />)
    expect(dom.querySelector('[data-testid="freq-badge"]')?.textContent).toContain('复发 3 次')
  })
})

describe('高扇入排除清单（验收项三：可见不黑箱；检视建议 6 DOM 断言补位）', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('非空清单渲染文件名与 ×N 计数', () => {
    const dom = render(<FanInExcludedList files={[{ file: 'src/app.ts', fanIn: 22 }, { file: 'src/router.ts', fanIn: 11 }]} />)
    const list = dom.querySelector('[data-testid="fanin-excluded"]')
    expect(list).not.toBeNull()
    expect(list?.textContent).toContain('app.ts')
    expect(list?.textContent).toContain('×22')
    expect(list?.textContent).toContain('router.ts')
    expect(list?.textContent).toContain('×11')
  })

  it('空清单不渲染', () => {
    const dom = render(<FanInExcludedList files={[]} />)
    expect(dom.querySelector('[data-testid="fanin-excluded"]')).toBeNull()
  })
})

describe('复发卡排序（检视建议 2：首屏卡序频次优先、其次最近复发）', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('按 commitCount 降序渲染（高频次在前，与传入顺序无关）', () => {
    const hot = recurrenceSignal({ id: 1, file_path: 'src/hot.ts' }) // 3 commits
    const cold = recurrenceSignal({
      id: 2, file_path: 'src/cold.ts',
      evidenceDetail: {
        kind: 'bug_recurrence_commits',
        windowDays: 30,
        commits: [{ sha: 'c1', date: '2026-08-25T00:00:00Z', changeType: 'BugFix', message: 'fix' }],
      },
    }) // 1 commit
    const dom = render(<RecurrenceSection signals={[cold, hot]} />) // 故意低频在前传入
    const cards = dom.querySelectorAll('[data-testid="recurrence-card"]')
    expect(cards).toHaveLength(2)
    expect(cards[0]?.textContent).toContain('hot.ts')
    expect(cards[1]?.textContent).toContain('cold.ts')
  })

  it('频次相同时按最近复发排序（最后节点日期新者在前）', () => {
    const older = recurrenceSignal({
      id: 3, file_path: 'src/older.ts',
      evidenceDetail: {
        kind: 'bug_recurrence_commits',
        windowDays: 30,
        commits: [
          { sha: 'd1', date: '2026-08-01T00:00:00Z', changeType: 'BugFix', message: 'fix1' },
          { sha: 'd2', date: '2026-08-05T00:00:00Z', changeType: 'New Feature', message: 'feat' },
          { sha: 'd3', date: '2026-08-10T00:00:00Z', changeType: 'BugFix', message: 'fix2' },
        ],
      },
    }) // 3 commits，最后节点 08/10
    const newer = recurrenceSignal({
      id: 4, file_path: 'src/newer.ts',
      evidenceDetail: {
        kind: 'bug_recurrence_commits',
        windowDays: 30,
        commits: [
          { sha: 'e1', date: '2026-08-20T00:00:00Z', changeType: 'BugFix', message: 'fix1' },
          { sha: 'e2', date: '2026-08-28T00:00:00Z', changeType: 'BugFix', message: 'fix2' },
          { sha: 'e3', date: '2026-08-30T00:00:00Z', changeType: 'New Feature', message: 'feat' },
        ],
      },
    }) // 3 commits，最后节点 08/30
    const dom = render(<RecurrenceSection signals={[older, newer]} />)
    const cards = dom.querySelectorAll('[data-testid="recurrence-card"]')
    expect(cards).toHaveLength(2)
    expect(cards[0]?.textContent).toContain('newer.ts')
    expect(cards[1]?.textContent).toContain('older.ts')
  })
})
