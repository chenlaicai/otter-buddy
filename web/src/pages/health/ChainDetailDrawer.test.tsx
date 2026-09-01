// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RhiChainDetailDTO } from '../../api/client'
import { ChainDetailDrawer } from './ChainDetailDrawer'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const detail: RhiChainDetailDTO = {
  featureId: 'F20260801aaaa',
  state: 'stalled',
  commitCount: 2,
  bugfixCount: 1,
  daysSinceLastCommit: 6,
  firstSeenAt: '2026-08-10T00:00:00.000Z',
  lastCommitAt: '2026-08-26T00:00:00.000Z',
  docStatus: 'development',
  docTitle: '测试链',
  stateReason: 'stalled：development 6 天内有提交，但已 6 天无活动',
  commits: [
    { sha: 'abcdef12', date: '2026-08-10T00:00:00.000Z', changeType: 'New Feature', message: 'feat: 引入', filesChanged: ['a.ts', 'b.ts'] },
    { sha: '12345678', date: '2026-08-26T00:00:00.000Z', changeType: 'BugFix', message: 'fix: 修复', filesChanged: ['a.ts'] },
  ],
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

function flush(): Promise<void> {
  return act(async () => { await Promise.resolve() })
}

describe('ChainDetailDrawer 链详情抽屉（Issue #649 交付 3）', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request) =>
      new Response(JSON.stringify({ chain: detail }), { status: 200 })))
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    for (const r of mounted.splice(0)) {
      await act(async () => r.unmount())
    }
    document.body.innerHTML = ''
  })

  it('featureId=null 不渲染', () => {
    const c = render(<ChainDetailDrawer featureId={null} onClose={() => {}} />)
    expect(c.querySelector('[data-testid="chain-drawer"]')).toBeNull()
  })

  it('拉取 chainDetail 并展示全量 commits（message/filesChanged/changeType）+ stateReason + docStatus', async () => {
    const c = render(<ChainDetailDrawer featureId="F20260801aaaa" onClose={() => {}} />)
    await flush()
    expect(c.querySelector('[data-testid="chain-drawer"]')).toBeTruthy()
    expect(c.querySelectorAll('[data-testid="chain-drawer-commit"]').length).toBe(2)
    const text = c.querySelector('[data-testid="chain-drawer-body"]')!.textContent ?? ''
    expect(text).toContain('feat: 引入')
    expect(text).toContain('fix: 修复')
    expect(text).toContain('2 文件 · a.ts, b.ts')
    expect(text).toContain('6 天内有提交')
    expect(text).toContain('文档状态：development')
  })

  it('点击遮罩/关闭按钮回调 onClose', async () => {
    let closed = false
    const c = render(<ChainDetailDrawer featureId="F20260801aaaa" onClose={() => { closed = true }} />)
    await flush()
    const backdrop = c.querySelector('[data-testid="chain-drawer-backdrop"]') as HTMLElement
    act(() => { backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(closed).toBe(true)
    const closeBtn = c.querySelector('[data-testid="chain-drawer-close"]') as HTMLElement
    act(() => { closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(closed).toBe(true)
  })

  it('接口报错显示错误态（不空白卡死）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 })))
    const c = render(<ChainDetailDrawer featureId="F20260801aaaa" onClose={() => {}} />)
    await flush()
    expect(c.querySelector('[data-testid="chain-drawer-error"]')?.textContent).toContain('boom')
  })
})
