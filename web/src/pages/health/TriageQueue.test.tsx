// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RhiSignalDTO } from '../../api/client'
import { TriageQueue, daysSince } from './TriageQueue'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** F20260917trig 验证 #7：处置队列分组渲染组件测试（web/src/pages/health/ 既有 vitest 模式） */

function sig(overrides: Partial<RhiSignalDTO>): RhiSignalDTO {
  return {
    id: 1,
    signalType: 'bug_recurrence',
    severity: 'critical',
    featureId: null,
    filePath: 'src/a.ts',
    evidence: 'e',
    firstSeen: '2026-09-10T00:00:00Z',
    lastSeen: '2026-09-16T00:00:00Z',
    occurrences: 3,
    status: 'open',
    suggestedAction: 's',
    signalTypeLabel: 'bug 反复出现',
    evidenceDetail: null,
    confidence: null,
    triageStatus: null,
    issueNumber: null,
    triagedAt: null,
    triageNote: null,
    ...overrides,
  }
}

const NOW = Date.parse('2026-09-17T00:00:00Z')

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

function flush(): Promise<void> {
  return act(async () => { await Promise.resolve() })
}

describe('TriageQueue 处置队列（F20260917trig §4）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request) =>
      new Response(JSON.stringify({ ok: true, record: {} }), { status: 200 })))
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    for (const r of mounted.splice(0)) {
      await act(async () => r.unmount())
    }
    document.body.innerHTML = ''
  })

  it('daysSince：向上取整、最少 1 天', () => {
    const now = Date.parse('2026-09-17T00:00:00Z')
    expect(daysSince('2026-09-16T12:00:00Z', now)).toBe(1) // 12h → 1 天
    expect(daysSince('2026-09-10T00:00:00Z', now)).toBe(7)
  })

  it('三分组渲染：未接单置顶 + 修复中 + 已归口折叠', () => {
    const dom = render(
      <TriageQueue
        now={NOW}
        signals={[
          sig({ id: 1, triageStatus: null, firstSeen: '2026-08-25T00:00:00Z' }), // 未接单 23 天
          sig({ id: 2, triageStatus: null, firstSeen: '2026-09-15T00:00:00Z' }), // 未接单 2 天
          sig({ id: 3, triageStatus: 'triaged', issueNumber: 1012, triagedAt: '2026-09-10T00:00:00Z' }),
          sig({ id: 4, triageStatus: 'in_progress', issueNumber: 1012 }),
        ]}
        onChanged={() => {}}
      />,
    )
    const headings = [...dom.querySelectorAll('h2')].map(h => h.textContent ?? '')
    expect(headings[0]).toContain('未接单')
    expect(headings[0]).toContain('2')
    expect(headings[1]).toContain('修复中')
    // 已归口组是 details/summary 折叠（不是 h2）
    expect(dom.querySelector('summary')?.textContent).toContain('已归口')
    expect(dom.querySelector('details')).not.toBeNull()
    // 未接单按 first_seen 降序（挂最久的 id=1 在前）
    const untriagedRows = [...dom.querySelectorAll('[data-signal-id]')].slice(0, 2).map(el => el.getAttribute('data-signal-id'))
    expect(untriagedRows).toStrictEqual(['1', '2'])
  })

  it('未接单行显示 open N 天 + 处置按钮；已归口行显示 issue 链接 + triaged N 天', () => {
    const dom = render(
      <TriageQueue
        now={NOW}
        signals={[
          sig({ id: 1, triageStatus: null, firstSeen: '2026-08-25T00:00:00Z' }),
          sig({ id: 3, triageStatus: 'triaged', issueNumber: 1012, triagedAt: '2026-09-10T00:00:00Z', triageNote: '并入 #1012' }),
        ]}
        onChanged={() => {}}
      />,
    )
    expect(dom.textContent).toContain('open 23 天')
    expect(dom.textContent).toContain('开 issue / 绑定')
    expect(dom.textContent).toContain('忽略')
    expect(dom.textContent).toContain('issue #1012')
    expect(dom.textContent).toContain('已归口 7 天')
    expect(dom.textContent).toContain('并入 #1012')
    // triaged 行不再有「开 issue/忽略」按钮（有「标为修复中」）
    expect(dom.textContent).toContain('标为修复中')
  })

  it('空队列渲染空态文案', () => {
    const dom = render(<TriageQueue signals={[]} onChanged={() => {}} />)
    expect(dom.querySelector('[data-testid="triage-queue-empty"]')).not.toBeNull()
  })

  it('dismiss 按钮：note 为空时确认按钮 disabled（note 必填约束的 UI 承载）', async () => {
    const dom = render(<TriageQueue signals={[sig({ id: 1 })]} onChanged={() => {}} />)
    // 点「忽略」展开输入区
    const dismissBtn = [...dom.querySelectorAll('button')].find(b => b.textContent === '忽略')!
    act(() => { dismissBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    const confirmBtn = [...dom.querySelectorAll('button')].find(b => b.textContent === '确认忽略')! as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true) // note 空 → disabled
  })
})
