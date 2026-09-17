// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RhiChainDTO } from '../../api/client'
import { ChainsPanel } from './ChainsPanel'
import { CHAIN_STATE_PROGRESS } from './chain-state-meta'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** issue #1029 验证：特性链页四态进度语言——异常排前、正常折叠、文案映射无黑话 */

function chain(featureId: string, state: string, daysSince = 1): RhiChainDTO {
  return {
    featureId,
    docTitle: `文档 ${featureId}`,
    state: state as RhiChainDTO['state'],
    commitCount: 3,
    daysSinceLastCommit: daysSince,
    commits: [
      { sha: 'a1', date: '2026-09-10', changeType: 'Feature', message: 'm' },
      { sha: 'a2', date: '2026-09-12', changeType: 'BugFix', message: 'fix' },
      { sha: 'a3', date: '2026-09-14', changeType: 'Feature', message: 'm2' },
    ],
    signals: [],
  } as RhiChainDTO
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

describe('ChainsPanel 分组排序', () => {
  it('异常链排最前，正常推进折叠在下方', () => {
    const chains = [
      chain('F-active-1', 'active'),
      chain('F-orphan-1', 'orphan', 20),
      chain('F-active-2', 'active'),
      chain('F-stalled-1', 'stalled', 12),
      chain('F-regressed-1', 'regressed', 3),
    ]
    const c = render(<ChainsPanel chains={chains} onOpen={() => {}} />)
    // 进度徽章文案映射（无黑话：stalled→卡住、orphan→烂尾风险、active→推进中）
    expect(c.querySelector('[data-testid="progress-badge-active"]')?.textContent).toBe('推进中 2')
    expect(c.querySelector('[data-testid="progress-badge-stalled"]')?.textContent).toBe('卡住 1')
    expect(c.querySelector('[data-testid="progress-badge-orphan"]')?.textContent).toBe('烂尾风险 1')
    expect(c.querySelector('[data-testid="progress-badge-regressed"]')?.textContent).toBe('出过回退 1')
    // 异常区存在且只含异常链
    const anomalyZone = c.querySelector('[data-testid="chain-anomaly-zone"]')
    expect(anomalyZone).toBeTruthy()
    const anomalyRows = anomalyZone!.querySelectorAll('[data-feature-id]')
    const ids = Array.from(anomalyRows).map(r => r.getAttribute('data-feature-id'))
    expect(ids).not.toContain('F-active-1')
    expect(ids).toContain('F-orphan-1')
    expect(ids).toContain('F-stalled-1')
    expect(ids).toContain('F-regressed-1')
    // 严重度序：regressed 最高（chainStateRank 4）在 orphan(2)/stalled(3) 之前
    expect(ids[0]).toBe('F-regressed-1')
    expect(ids[1]).toBe('F-stalled-1')
    expect(ids[2]).toBe('F-orphan-1')
    // 正常推进默认折叠
    expect(c.querySelector('[data-testid="normal-chains-list"]')).toBeNull()
    expect(c.querySelector('[data-testid="normal-chains-toggle"]')?.textContent).toContain('其余 2 件正常推进')
  })

  it('点折叠开关展开正常推进泳道', () => {
    const chains = [chain('F-active-1', 'active'), chain('F-stalled-1', 'stalled', 12)]
    const c = render(<ChainsPanel chains={chains} onOpen={() => {}} />)
    const toggle = c.querySelector('[data-testid="normal-chains-toggle"]')!
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const list = c.querySelector('[data-testid="normal-chains-list"]')
    expect(list).toBeTruthy()
    expect(list!.querySelector('[data-feature-id="F-active-1"]')).toBeTruthy()
    // 再点收起
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(c.querySelector('[data-testid="normal-chains-list"]')).toBeNull()
  })

  it('全正常（无异常）时不渲染异常区，折叠区直接可见提示', () => {
    const chains = [chain('F-active-1', 'active'), chain('F-active-2', 'active')]
    const c = render(<ChainsPanel chains={chains} onOpen={() => {}} />)
    expect(c.querySelector('[data-testid="chain-anomaly-zone"]')).toBeNull()
    expect(c.textContent).toContain('推进中 2')
  })

  it('全空给确定感空态', () => {
    const c = render(<ChainsPanel chains={[]} onOpen={() => {}} />)
    expect(c.textContent).toContain('没有进行中的事')
  })
})

describe('文案映射（chain-state-meta 进度语言）', () => {
  it('四态进度标签齐全且无内部黑话（stalled/orphan/regressed 不直接出现在进度标签）', () => {
    const labels = Object.values(CHAIN_STATE_PROGRESS).map(m => m.label)
    expect(labels).toEqual(['推进中', '卡住', '出过回退', '烂尾风险'])
    for (const l of labels) {
      expect(l).not.toMatch(/stalled|orphan|regressed|active/i)
    }
  })
})
