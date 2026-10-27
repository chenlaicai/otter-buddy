/**
 * F20261027hwl1：模型效率面板——真实 provider+model × 日/周/月 token 总量 + KV cache 率。
 *
 * 每格：totalTokens 主数字 + cacheHitRate（零分母显「—」）；日/周/月并列
 * （原始量重汇总，不是日均）。空态：snapshotDays=0 时说明等首次扫描，不显示演示矩阵。
 */
import { useEffect, useState } from 'react'
import * as api from '../../api/client'
import type { ModelEfficiencyCellDTO, ModelEfficiencyDTO } from '../../api/client'

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function fmtRate(rate: number | null): string {
  if (rate === null) return '—'
  return `${(rate * 100).toFixed(0)}%`
}

function Cell({ cell }: { cell: ModelEfficiencyCellDTO | null }) {
  if (!cell) return <div className="text-stone-300 text-sm">—</div>
  return (
    <div>
      <div className="text-sm font-semibold text-stone-800 tabular-nums">{fmtTokens(cell.totalTokens)}</div>
      <div className="text-[11px] text-stone-400 tabular-nums">
        cache {fmtRate(cell.cacheHitRate)} · {cell.callCount} 次{cell.errorCalls > 0 ? ` · ${cell.errorCalls} 失败` : ''}
      </div>
    </div>
  )
}

export function ModelEfficiencyPanel() {
  const [report, setReport] = useState<ModelEfficiencyDTO | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    api.getModelEfficiency(controller.signal)
      .then(setReport)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
    return () => controller.abort()
  }, [])

  if (error) {
    return <div className="py-8 text-sm text-caramel-600 text-center" data-testid="model-efficiency-error">加载失败：{error}</div>
  }

  if (!report) {
    return <div className="py-8 text-sm text-stone-400 text-center" data-testid="model-efficiency-loading">加载中…</div>
  }

  if (report.snapshotDays === 0) {
    return (
      <div className="rounded-xl border border-dashed border-stone-200 px-6 py-10 text-center" data-testid="model-efficiency-empty">
        <p className="text-sm text-stone-500">暂无模型用量快照</p>
        <p className="text-xs text-stone-400 mt-1">健康面板的下一轮扫描会从 session 记录采集真实 provider/model 用量（Asia/Shanghai 日界）。</p>
      </div>
    )
  }

  return (
    <div className="space-y-3" data-testid="model-efficiency-panel">
      <div className="text-xs text-stone-400">
        窗口（{report.timezone}）：今日 {report.windows.day.start} · 本周 {report.windows.week.start} 起 · 本月 {report.windows.month.start} 起。
        周/月为日级原始量重汇总；cache 率 = cacheRead / (input + cacheRead)，零分母显「—」。
      </div>
      <div className="rounded-xl bg-white border border-stone-100 overflow-x-auto">
        <table className="w-full text-sm" data-testid="model-efficiency-table">
          <thead>
            <tr className="text-xs text-stone-500 border-b border-stone-100">
              <th className="text-left font-medium px-4 py-2.5">provider / model</th>
              <th className="text-left font-medium px-3 py-2.5">今日</th>
              <th className="text-left font-medium px-3 py-2.5">本周</th>
              <th className="text-left font-medium px-3 py-2.5">本月</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-50">
            {report.rows.map(r => (
              <tr key={`${r.provider}|${r.model}`} data-testid="model-efficiency-row">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-stone-800">{r.model}</div>
                  <div className="text-[11px] text-stone-400">{r.provider}</div>
                </td>
                <td className="px-3 py-2.5"><Cell cell={r.day} /></td>
                <td className="px-3 py-2.5"><Cell cell={r.week} /></td>
                <td className="px-3 py-2.5"><Cell cell={r.month} /></td>
              </tr>
            ))}
            {/* 合计行 */}
            <tr className="bg-otter-50/40 font-medium" data-testid="model-efficiency-total">
              <td className="px-4 py-2.5 text-stone-700">全部模型</td>
              <td className="px-3 py-2.5"><Cell cell={report.totals.day} /></td>
              <td className="px-3 py-2.5"><Cell cell={report.totals.week} /></td>
              <td className="px-3 py-2.5"><Cell cell={report.totals.month} /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
