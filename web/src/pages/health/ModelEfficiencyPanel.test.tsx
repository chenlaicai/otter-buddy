// @vitest-environment jsdom
/**
 * F20261027hwl1 模型效率面板行为测试（A 类）：
 * - 真空态：snapshotDays=0 → 说明文案（不显示演示矩阵）
 * - 有数据：provider/model 行渲染；零分母 cache 率显「—」
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ModelEfficiencyDTO } from '../../api/client'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  vi.resetModules()
  vi.restoreAllMocks()
})

async function renderPanel(report: ModelEfficiencyDTO): Promise<void> {
  vi.doMock('../../api/client', () => ({
    getModelEfficiency: vi.fn().mockResolvedValue(report),
  }))
  const { ModelEfficiencyPanel } = await import('./ModelEfficiencyPanel')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(<ModelEfficiencyPanel />) })
}

function emptyReport(): ModelEfficiencyDTO {
  return {
    timezone: 'Asia/Shanghai',
    windows: {
      day: { start: '2026-10-27', end: '2026-10-27' },
      week: { start: '2026-10-26', end: '2026-10-27' },
      month: { start: '2026-10-01', end: '2026-10-27' },
    },
    rows: [],
    totals: { day: null, week: null, month: null },
    snapshotDays: 0,
  }
}

function reportWithData(): ModelEfficiencyDTO {
  return {
    timezone: 'Asia/Shanghai',
    windows: {
      day: { start: '2026-10-27', end: '2026-10-27' },
      week: { start: '2026-10-26', end: '2026-10-27' },
      month: { start: '2026-10-01', end: '2026-10-27' },
    },
    rows: [
      {
        provider: 'zhipu', model: 'glm-5.3',
        day: { totalTokens: 21146, inputTokens: 4227, outputTokens: 599, cacheReadTokens: 16320, cacheWriteTokens: 0, cacheHitRate: 0.7943, callCount: 2, errorCalls: 0 },
        week: { totalTokens: 36083, inputTokens: 15107, outputTokens: 432, cacheReadTokens: 20544, cacheWriteTokens: 0, cacheHitRate: 0.5765, callCount: 4, errorCalls: 0 },
        month: { totalTokens: 57229, inputTokens: 19334, outputTokens: 1031, cacheReadTokens: 36864, cacheWriteTokens: 0, cacheHitRate: 0.6562, callCount: 6, errorCalls: 1 },
      },
      {
        provider: 'unknown', model: 'unknown-model',
        day: { totalTokens: 100, inputTokens: 0, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: null, callCount: 1, errorCalls: 0 },
        week: null, month: null,
      },
    ],
    totals: {
      day: { totalTokens: 21246, inputTokens: 4227, outputTokens: 699, cacheReadTokens: 16320, cacheWriteTokens: 0, cacheHitRate: 0.7943, callCount: 3, errorCalls: 0 },
      week: null, month: null,
    },
    snapshotDays: 26,
  }
}

describe('ModelEfficiencyPanel', () => {
  it('真空态：无快照显示引导文案，不渲染演示矩阵', async () => {
    await renderPanel(emptyReport())
    expect(document.querySelector('[data-testid="model-efficiency-empty"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="model-efficiency-table"]')).toBeNull()
  })

  it('有数据：provider/model 行 + 零分母 cache 率显「—」', async () => {
    await renderPanel(reportWithData())
    const rows = document.querySelectorAll('[data-testid="model-efficiency-row"]')
    expect(rows.length).toBe(2)
    expect(rows[0]?.textContent).toContain('glm-5.3')
    expect(rows[0]?.textContent).toContain('zhipu')
    // 零分母（input=0, cacheRead=0）的 cache 率显示「—」而非 0%
    expect(rows[1]?.textContent).toContain('—')
    expect(document.querySelector('[data-testid="model-efficiency-total"]')).not.toBeNull()
  })
})
