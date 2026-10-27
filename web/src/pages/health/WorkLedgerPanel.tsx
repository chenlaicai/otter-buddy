/**
 * F20261027hwl1：工作账本面板——全宽工作列表 + 覆盖率/未归属 + 居中详情浮窗。
 *
 * 展示原则（特性文档）：token 主数字、金额仅参考（本期未配置单价不显示）；
 * 未归属与 usageGap 显式呈现（不给空表伪装完整）；evidenceQuality 区分
 * tracked / historical-partial（历史部分归属不冒充精确账）。
 */
import { useEffect, useState } from 'react'
import * as api from '../../api/client'
import type { WorkLedgerDTO, WorkReportItemDTO } from '../../api/client'
import { WorkDetailDialog } from './WorkDetailDialog'

const STATUS_LABELS: Record<WorkReportItemDTO['status'], string> = {
  active: '进行中',
  delivered: '已交付',
  merged: '已合入',
  closed: '已结束',
  cancelled: '已取消',
}

const ORIGIN_LABELS: Record<WorkReportItemDTO['originKind'], string> = {
  feature: 'F 文档',
  matter: '待办',
  manual: '手动',
  'inferred-historical': '历史归集',
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function WorkLedgerPanel() {
  const [ledger, setLedger] = useState<WorkLedgerDTO | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeWorkId, setActiveWorkId] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    api.getWorkLedger(controller.signal)
      .then(setLedger)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
    return () => controller.abort()
  }, [])

  if (error) {
    return <div className="py-8 text-sm text-caramel-600 text-center" data-testid="work-ledger-error">加载失败：{error}</div>
  }

  if (!ledger) {
    return <div className="py-8 text-sm text-stone-400 text-center" data-testid="work-ledger-loading">加载中…</div>
  }

  const coverage = ledger.attributionCoverage

  return (
    <div className="space-y-4" data-testid="work-ledger-panel">
      {/* 覆盖率 + 未归属 + 数据缺口概览行 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl bg-white border border-stone-100 px-3 py-2.5">
          <div className="text-xs text-stone-500">归属覆盖率</div>
          <div className="text-lg font-semibold text-stone-800 tabular-nums" data-testid="work-ledger-coverage">
            {coverage === null ? '—' : `${(coverage * 100).toFixed(0)}%`}
          </div>
          {coverage === null && <div className="text-[11px] text-stone-400">尚无带 trace 的调用</div>}
        </div>
        <div className="rounded-xl bg-white border border-stone-100 px-3 py-2.5">
          <div className="text-xs text-stone-500">未归属调用</div>
          <div className="text-lg font-semibold text-stone-800 tabular-nums">{ledger.unassigned.invokeCount}</div>
          <div className="text-[11px] text-stone-400">
            {ledger.unassigned.noTraceCount} 无 trace · {ledger.unassigned.unboundTraceCount} 有 trace 未绑定
          </div>
        </div>
        <div className="rounded-xl bg-white border border-stone-100 px-3 py-2.5">
          <div className="text-xs text-stone-500">未归属 token</div>
          <div className="text-lg font-semibold text-stone-800 tabular-nums">{fmtTokens(ledger.unassigned.tokens.totalTokens)}</div>
        </div>
        <div className="rounded-xl bg-white border border-stone-100 px-3 py-2.5">
          <div className="text-xs text-stone-500">usage 缺失调用</div>
          <div className="text-lg font-semibold text-stone-800 tabular-nums" data-testid="work-ledger-usage-gap">{ledger.usageGapInvokeCount}</div>
          <div className="text-[11px] text-stone-400">数据缺口显式列出，不当零</div>
        </div>
      </div>

      {!ledger.pricingAvailable && (
        <p className="text-xs text-stone-400">金额参考：未配置可信单价，本页不显示金额（不使用演示价格）。</p>
      )}

      {/* 工作全宽列表 */}
      {ledger.works.length === 0 ? (
        <div className="rounded-xl border border-dashed border-stone-200 px-6 py-10 text-center" data-testid="work-ledger-empty">
          <p className="text-sm text-stone-500">还没有登记的工作</p>
          <p className="text-xs text-stone-400 mt-1">
            獭用 track_work 工具登记后，这里按工作展示全生命周期 token、参与獭与检视轮次。历史调用在未归属区可见。
          </p>
        </div>
      ) : (
        <div className="rounded-xl bg-white border border-stone-100 divide-y divide-stone-100" data-testid="work-ledger-list">
          {ledger.works.map(w => (
            <button
              key={w.workId}
              onClick={() => setActiveWorkId(w.workId)}
              className="w-full text-left px-4 py-3 hover:bg-otter-50/40 transition-colors flex items-center gap-3 flex-wrap"
              data-testid="work-ledger-row"
            >
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${w.status === 'active' ? 'bg-otter-100 text-otter-700' : w.status === 'cancelled' ? 'bg-stone-100 text-stone-500' : 'bg-lavender-100 text-lavender-700'}`}>
                {STATUS_LABELS[w.status]}
              </span>
              <span className="font-medium text-stone-800 min-w-0 truncate flex-1">{w.title}</span>
              <span className="text-xs text-stone-400">{ORIGIN_LABELS[w.originKind]}{w.originId ? ` ${w.originId}` : ''}</span>
              {w.evidenceQuality === 'historical-partial' && (
                <span className="px-1.5 py-0.5 rounded text-[11px] bg-caramel-50 text-caramel-600">历史部分归属</span>
              )}
              <span className="text-sm tabular-nums text-stone-700 font-medium">{fmtTokens(w.tokens.totalTokens)} tok</span>
              <span className="text-xs text-stone-400 tabular-nums">{w.participants.length} 獭 · {w.invokeCount} 次</span>
              <span className="text-xs text-stone-400">
                {w.roundsRecorded ? `检视 ${w.reviewRounds.length} 轮` : '检视未记录'}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* 居中详情浮窗（Esc/遮罩/× 均可关闭） */}
      <WorkDetailDialog workId={activeWorkId} onClose={() => setActiveWorkId(null)} />
    </div>
  )
}
