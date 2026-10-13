// @vitest-environment jsdom
/**
 * F20261012qtbc：QuotaBoard 渲染态测试（假 api 注入，无网络）。
 * 覆盖：ok 窗口条渲染 / 耗尽红条+「耗尽」/ needs-login 登录按钮 / error 重试。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { QuotaSnapshotDTO } from '../../api/client'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../api/client', () => ({
  getQuota: vi.fn(),
  triggerQuotaLogin: vi.fn(),
}))
vi.mock('../../components/Toast', () => ({
  showToast: vi.fn(),
}))

const { QuotaBoard } = await import('./QuotaBoard')
const api = await import('../../api/client')

const SNAPSHOT: QuotaSnapshotDTO = {
  stale: false,
  providers: [
    {
      provider: 'glm',
      label: '智谱 GLM',
      status: 'ok',
      fetchedAt: '2026-10-12T07:00:00.000Z',
      windows: [
        { key: '5h', label: '5 小时', used: 660000, limit: 1000000, remaining: 340000, remainingRatio: 0.34, resetAt: '2026-10-12T10:00:00.000Z' },
        { key: 'week', label: '本周', used: 1000000, limit: 1000000, remaining: 0, remainingRatio: 0, resetAt: '2026-10-15T04:46:05.000Z' },
      ],
    },
    {
      provider: 'kimi',
      label: 'Kimi',
      status: 'needs-login',
      fetchedAt: '2026-10-12T07:00:00.000Z',
      windows: [],
      error: '网页登录态缺失或过期，请重新登录',
    },
    {
      provider: 'mimo',
      label: 'MiMo',
      status: 'error',
      fetchedAt: '2026-10-12T07:00:00.000Z',
      windows: [],
      error: '配额响应结构未识别（原始响应已落日志，待锁定字段映射）',
    },
  ],
}

async function renderBoard(): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<QuotaBoard />)
    await Promise.resolve()
  })
  return {
    container,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getQuota).mockResolvedValue(SNAPSHOT)
})

describe('QuotaBoard', () => {
  it('ok 窗口：标签/数值/重置时间渲染', async () => {
    const { container, unmount } = await renderBoard()
    expect(container.querySelector('[data-testid="quota-card-glm"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="quota-window-5h"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="quota-window-week"]')).not.toBeNull()
    expect(container.textContent).toContain('5 小时')
    expect(container.textContent).toContain('已用 660,000 / 1,000,000')
    expect(container.textContent).toContain('重置')
    unmount()
  })

  it('血条展示已用量：已用 66% 橙、耗尽红满条', async () => {
    const { container, unmount } = await renderBoard()
    // 已用占比 = 1 - remainingRatio；5h 窗 remainingRatio=0.34 → 已用 66% → 橙
    const bar5h = container.querySelector('[data-testid="quota-bar-5h"]') as HTMLElement;
    expect(bar5h.className).toContain('bg-amber-500')
    expect(bar5h.style.width).toBe('66%')
    // 周窗 remainingRatio=0 → 已用 100% → 红满条
    const barWeek = container.querySelector('[data-testid="quota-bar-week"]') as HTMLElement;
    expect(barWeek.className).toContain('bg-rose-500')
    expect(barWeek.style.width).toBe('100%')
    expect(container.textContent).toContain('耗尽')
    unmount()
  })

  it('needs-login：登录按钮渲染', async () => {
    const { container, unmount } = await renderBoard()
    expect(container.querySelector('[data-testid="quota-login-kimi"]')).not.toBeNull()
    expect(container.textContent).toContain('需登录')
    unmount()
  })

  it('error：采集失败徽章 + 重试按钮', async () => {
    const { container, unmount } = await renderBoard()
    expect(container.textContent).toContain('采集失败')
    expect(container.textContent).toContain('结构未识别')
    expect(container.textContent).toContain('重试')
    unmount()
  })
})
