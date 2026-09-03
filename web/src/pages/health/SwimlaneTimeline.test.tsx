// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RhiChainDTO } from '../../api/client'
import { SwimlaneTimeline, ChainFilterChips, sortChainsBySeverity } from './SwimlaneTimeline'
import { CHAIN_STATE_META, commitNodeColor } from './chain-state-meta'
import { TEAL, CARAMEL, LAVENDER } from './palette'

// 页面入口 index.tsx 在 import 时挂载 #root，本测试不 import 它，无副作用
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** 单链夹具：60 天窗口内 3 commits（BugFix 收尾 = regressed 语义） */
function chain(state: RhiChainDTO['state'], featureId: string, overrides: Partial<RhiChainDTO> = {}): RhiChainDTO {
  const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString()
  return {
    featureId,
    state,
    signals: [],
    commitCount: 3,
    bugfixCount: 1,
    daysSinceLastCommit: 1,
    firstSeenAt: daysAgo(50),
    lastCommitAt: daysAgo(1),
    docStatus: 'development',
    docTitle: `链 ${featureId}`,
    stateReason: '测试链',
    commits: [
      { sha: 'aaa11111', date: daysAgo(50), changeType: 'New Feature' },
      { sha: 'bbb22222', date: daysAgo(30), changeType: 'Refactor' },
      { sha: 'ccc33333', date: daysAgo(1), changeType: 'BugFix' },
    ],
    ...overrides,
  }
}

let container: HTMLElement
let root: Root
const mounted: Root[] = []

function render(ui: React.ReactNode): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted.push(root)
  act(() => root.render(ui))
  return container
}

/** svg 元素属性查询（class/data 属性断言用） */
function q(c: HTMLElement, sel: string): Element | null {
  return c.querySelector(sel)
}

describe('SwimlaneTimeline 泳道时间线（Issue #649 视觉契约）', () => {
  it('F20260902sigm 四态行各带 data-state（zombie 已删除）', () => {
    const states: RhiChainDTO['state'][] = ['active', 'stalled', 'regressed', 'orphan']
    const c = render(<SwimlaneTimeline chains={states.map(s => chain(s, `F${s}`))} onOpen={() => {}} />)
    for (const s of states) {
      const row = c.querySelector(`g.swim-row[data-state="${s}"]`)
      expect(row, `state=${s} 行应存在`).toBeTruthy()
    }
  })

  it('active 末端呼吸动画（全场唯一动效）：swim-active-pulse + SMIL animate', () => {
    const c = render(<SwimlaneTimeline chains={[chain('active', 'F1')]} onOpen={() => {}} />)
    const pulse = c.querySelector('circle.swim-active-pulse')
    expect(pulse).toBeTruthy()
    expect(pulse!.querySelector('animate')).toBeTruthy()
  })

  it('stalled（pr-stalled）线尾虚化 + 空心圆 + PR 停滞旁注（三要素 DOM 断言）', () => {
    const c = render(<SwimlaneTimeline chains={[chain('stalled', 'F2', {
      signals: [{ id: 'pr-stalled', evidence: 'open PR #42 已 6 天无推进', stalledPrs: [{ number: 42, url: null, daysSinceActivity: 6 }] }],
    })]} onOpen={() => {}} />)
    expect(q(c, 'line.swim-stalled-fade')).toBeTruthy()
    expect(q(c, 'circle.swim-stalled-end')).toBeTruthy()
    const label = c.querySelector('text.swim-stalled-label')
    expect(label?.textContent).toContain('#42 停 6 天')
  })

  it('orphan 悬空空心起点：lavender 空心圆（fill=none）', () => {
    const c = render(<SwimlaneTimeline chains={[chain('orphan', 'F4')]} onOpen={() => {}} />)
    const start = c.querySelector('circle.swim-orphan-start') as SVGElement | null
    expect(start).toBeTruthy()
    expect(start!.getAttribute('fill')).toBe('none')
    expect(start!.getAttribute('stroke')).toBe(LAVENDER[400])
  })

  it('regressed 回卷标记：swim-regressed-mark（caramel-700 深阶 stroke）', () => {
    const c = render(<SwimlaneTimeline chains={[chain('regressed', 'F5')]} onOpen={() => {}} />)
    const mark = c.querySelector('path.swim-regressed-mark') as SVGElement | null
    expect(mark).toBeTruthy()
    expect(mark!.getAttribute('stroke')).toBe(CARAMEL[700])
  })

  it('节点色义：bug 系=caramel、其他=teal（复发卡同款）', () => {
    expect(commitNodeColor('BugFix')).toBe(CARAMEL[500])
    expect(commitNodeColor('Experiment')).toBe(CARAMEL[500])
    expect(commitNodeColor('New Feature')).toBe(TEAL[400])
    expect(commitNodeColor(null)).toBe(TEAL[400])
  })

  it('共享 x 轴刻度 7 档', () => {
    const c = render(<SwimlaneTimeline chains={[chain('active', 'F6')]} onOpen={() => {}} />)
    expect(c.querySelectorAll('g.swim-x-axis text').length).toBe(7)
  })

  it('窗口外老链：起点贴左缘截断（data-clipped-start）', () => {
    const old = chain('active', 'Fold', {
      commits: [
        { sha: 'old00001', date: new Date(Date.now() - 100 * 86400000).toISOString(), changeType: 'New Feature' },
        { sha: 'new00001', date: new Date(Date.now() - 2 * 86400000).toISOString(), changeType: 'BugFix' },
      ],
    })
    const c = render(<SwimlaneTimeline chains={[old]} onOpen={() => {}} />)
    expect(q(c, 'g.swim-row[data-clipped-start="1"]')).toBeTruthy()
    expect(q(c, 'g.swim-clipped-mark')).toBeTruthy()
  })

  it('点击行触发 onOpen（抽屉联动）', () => {
    let opened: string | null = null
    const c = render(<SwimlaneTimeline chains={[chain('active', 'Fclick')]} onOpen={id => { opened = id }} />)
    const row = c.querySelector('g.swim-row[data-state="active"]') as SVGGElement
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(opened).toBe('Fclick')
  })

  it('窗口化：329 链只渲染可视区间（±4 行 overscan），不全量挂载', () => {
    const many = Array.from({ length: 329 }, (_, i) => chain(i % 2 ? 'active' : 'stalled', `F${String(i).padStart(3, '0')}`))
    const c = render(<SwimlaneTimeline chains={many} onOpen={() => {}} />)
    const rows = c.querySelectorAll('g.swim-row').length
    expect(rows).toBeLessThanOrEqual(4 + 4 + Math.ceil(480 / 38) + 4) // start margin + viewport + overscan
    expect(rows).toBeGreaterThan(0)
    expect(rows).toBeLessThan(329)
  })

  it('空链列表：空态占位，不渲染泳道', () => {
    const c = render(<SwimlaneTimeline chains={[]} onOpen={() => {}} />)
    expect(q(c, '[data-testid="swimlane-empty"]')).toBeTruthy()
    expect(q(c, 'g.swim-row')).toBeNull()
  })
})

describe('ChainFilterChips 异常筛选（§3.2 视觉反转）', () => {
  const counts = { active: 275, stalled: 50, regressed: 2, orphan: 4 }

  it('异常 chips 实心（色底白字）+ 计数徽章；活跃 chip 描边灰显', () => {
    const c = render(<ChainFilterChips counts={counts} total={338} active={null} onPick={() => {}} />)
    const stalledChip = c.querySelector('[data-testid="chip-stalled"]') as HTMLElement
    expect(stalledChip.getAttribute('data-count')).toBe('50')
    // 实心：异常 chip 直接用态色做背景
    expect(stalledChip.style.backgroundColor).toBeTruthy()
    const activeChip = c.querySelector('[data-testid="chip-active"]') as HTMLElement
    expect(activeChip.className).toContain('bg-white')
    expect(activeChip.className).toContain('border-stone-200')
  })

  it('点击异常 chip → onPick(state)；选中态再点取消 → onPick(null)', () => {
    let picked: string | null = null
    const c = render(<ChainFilterChips counts={counts} total={331} active={null} onPick={s => { picked = s }} />)
    const regressedChip = c.querySelector('[data-testid="chip-regressed"]') as HTMLElement
    act(() => { regressedChip.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(picked).toBe('regressed')
    // 选中态（active=regressed）重渲染后，再点同一 chip = 取消
    act(() => root.render(<ChainFilterChips counts={counts} total={331} active={'regressed'} onPick={s => { picked = s }} />))
    const chipAgain = c.querySelector('[data-testid="chip-regressed"]') as HTMLElement
    expect(chipAgain.getAttribute('data-active')).toBe('1')
    act(() => { chipAgain.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(picked).toBeNull()
  })

  it('零计数异常 chip 降透明度（仍可见可点，最小可见性保底不适用于筛选器）', () => {
    const c = render(<ChainFilterChips counts={{ active: 10 }} total={10} active={null} onPick={() => {}} />)
    const orphanChip = c.querySelector('[data-testid="chip-orphan"]') as HTMLElement
    expect(orphanChip.style.opacity).toBe('0.45')
  })

  it('排序：状态严重度优先（regressed > stalled > orphan > active），同态按最近活动', () => {
    const input = [
      chain('active', 'Fa', { daysSinceLastCommit: 1 }),
      chain('stalled', 'Fs', { daysSinceLastCommit: 20 }),
      chain('orphan', 'Fo', { daysSinceLastCommit: 40 }),
      chain('regressed', 'Fr', { daysSinceLastCommit: 2 }),
    ]
    const sorted = sortChainsBySeverity(input)
    expect(sorted.map(c => c.state)).toEqual(['regressed', 'stalled', 'orphan', 'active'])
  })
})

describe('四态元数据（chain-state-meta 单一真相源）', () => {
  it('色义锁定：与观澜 §3.4 表一致（F20260902sigm：zombie 删除）', () => {
    expect(CHAIN_STATE_META.active.color).toBe(TEAL[500])
    expect(CHAIN_STATE_META.stalled.color).toBe(CARAMEL[500])
    expect(CHAIN_STATE_META.regressed.color).toBe(CARAMEL[700])
    expect(CHAIN_STATE_META.orphan.color).toBe(LAVENDER[400])
  })
})
