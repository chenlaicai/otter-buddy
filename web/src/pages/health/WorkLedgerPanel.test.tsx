// @vitest-environment jsdom
/**
 * F20261027hwl1 工作账本面板行为测试（A 类）：
 * - 真实空态：无 works → 引导文案（不伪装完整）
 * - 未归属/usageGap/覆盖率显式呈现
 * - 有数据：行点击 → dialog 打开；× 按钮关闭
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { WorkLedgerDTO, WorkDetailDTO } from '../../api/client'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// jsdom 无原生 dialog showModal——打桩 open 标记（断言 open 翻转即可，真浏览器验证在 alpha 阶段）
beforeAllPatch()
function beforeAllPatch(): void {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { open: boolean }
  if (!proto.showModal) {
    proto.showModal = function (this: HTMLDialogElement) { (this as { open?: boolean }).open = true }
    proto.close = function (this: HTMLDialogElement) { (this as { open?: boolean }).open = false; this.dispatchEvent(new Event('close')) }
  }
}

let container: HTMLElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  vi.resetModules()
  vi.restoreAllMocks()
})

async function renderPanel(ledger: WorkLedgerDTO, detail: WorkDetailDTO | null): Promise<void> {
  vi.doMock('../../api/client', () => ({
    getWorkLedger: vi.fn().mockResolvedValue(ledger),
    getWorkDetail: detail ? vi.fn().mockResolvedValue(detail) : vi.fn().mockRejectedValue(new Error('not found')),
    getModelEfficiency: vi.fn(),
  }))
  const { WorkLedgerPanel } = await import('./WorkLedgerPanel')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(<WorkLedgerPanel />) })
}

function emptyLedger(): WorkLedgerDTO {
  return {
    works: [],
    attributionCoverage: null,
    unassigned: { invokeCount: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, unboundTraceCount: 0, noTraceCount: 0 },
    usageGapInvokeCount: 0,
    pricingAvailable: false,
  }
}

function ledgerWithWork(): WorkLedgerDTO {
  return {
    works: [{
      workId: 'w-1',
      title: '修复每日派工漏提醒',
      status: 'active',
      originKind: 'manual',
      originId: null,
      evidenceQuality: 'tracked',
      createdAt: '2026-10-27T10:00:00Z',
      closedAt: null,
      tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0, totalTokens: 1700 },
      participants: [{ otterId: 'otter-a' }, { otterId: 'otter-b' }],
      reviewRounds: [{ roundNo: 1, reviewerOtterId: 'otter-b', state: 'passed', passedAt: '2026-10-27T12:00:00Z' }],
      roundsRecorded: true,
      invokeCount: 5,
    }],
    attributionCoverage: 0.6,
    unassigned: { invokeCount: 3, tokens: { input: 300, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 400 }, unboundTraceCount: 1, noTraceCount: 2 },
    usageGapInvokeCount: 2,
    pricingAvailable: false,
  }
}

const detail: WorkDetailDTO = {
  work: {
    id: 'w-1', title: '修复每日派工漏提醒', originKind: 'manual', originId: null,
    status: 'active', evidenceQuality: 'tracked',
    createdAt: '2026-10-27T10:00:00Z', closedAt: null, reviewRounds: [],
  },
  tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0, totalTokens: 1700 },
  participants: [{ otterId: 'otter-a', invokeCount: 3 }, { otterId: 'otter-b', invokeCount: 2 }],
  traces: [{ traceId: 't-abc', boundAt: '2026-10-27T10:00:00Z', boundVia: 'track_work' }],
  invokeEvidence: [{
    invokeId: 'i-1', otterId: 'otter-a', conversationId: 'c-1', startedAt: '2026-10-27T10:05:00Z',
    tokens: { input: 100, output: 50, cacheRead: 20, cacheWrite: 0, totalTokens: 170 }, hasUsage: true,
  }],
  truncatedCount: 0,
  totalInvokeCount: 1,
  usageGapCount: 0,
  pricingAvailable: false,
}

describe('WorkLedgerPanel', () => {
  it('真实空态：无工作显示引导文案，不显示假矩阵', async () => {
    await renderPanel(emptyLedger(), null)
    expect(document.querySelector('[data-testid="work-ledger-empty"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="work-ledger-coverage"]')?.textContent).toBe('—')
  })

  it('未归属与 usage 缺口显式呈现；轮次有留痕时显示轮数', async () => {
    await renderPanel(ledgerWithWork(), detail)
    expect(document.querySelector('[data-testid="work-ledger-usage-gap"]')?.textContent).toBe('2')
    expect(document.querySelector('[data-testid="work-ledger-coverage"]')?.textContent).toBe('60%')
    expect(document.querySelector('[data-testid="work-ledger-row"]')?.textContent).toContain('检视 1 轮')
  })

  it('点击工作行打开 dialog；× 按钮触发关闭回调', async () => {
    await renderPanel(ledgerWithWork(), detail)
    const row = document.querySelector('[data-testid="work-ledger-row"]') as HTMLButtonElement
    await act(async () => { row.click() })
    const dlg = document.querySelector('[data-testid="work-detail-dialog"]') as HTMLDialogElement & { open?: boolean }
    expect(dlg).not.toBeNull()
    expect(dlg.open).toBe(true)
    // 关闭按钮可点（关闭语义由 onClose/onclose 回调驱动，此处验证按钮存在且可触发 close）
    const closeBtn = document.querySelector('[data-testid="work-detail-close"]') as HTMLButtonElement
    expect(closeBtn).not.toBeNull()
    await act(async () => { closeBtn.click() })
    expect((document.querySelector('[data-testid="work-detail-dialog"]') as HTMLDialogElement & { open?: boolean })?.open).toBeFalsy()
  })
})
