/**
 * F20261027hwl1：工作详情浮窗——原生 <dialog> 居中模态。
 *
 * 交互（原型修订）：点击工作行打开居中浮窗（非右侧栏）；Esc / 遮罩点击 / × 都可关闭；
 * 关闭后焦点返回触发按钮。数据全部真实（404 → 错误态；无 usage → 显式「缺失」标记）。
 */
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import * as api from '../../api/client'
import type { WorkDetailDTO, WorkReportItemDTO, WorkReviewRoundDTO } from '../../api/client'

const STATUS_LABELS: Record<WorkReportItemDTO['status'], string> = {
  active: '进行中',
  delivered: '已交付',
  merged: '已合入',
  closed: '已结束',
  cancelled: '已取消',
}

const ROUND_STATE_LABELS: Record<WorkReviewRoundDTO['state'], string> = {
  'reviewing': '检视中',
  'awaiting-fix': '待修复',
  'delta-review': 'delta 复核',
  'passed': '已通过',
  'open-unknown': '开启（未记录）',
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

interface Props {
  workId: string | null
  onClose: () => void
}

export function WorkDetailDialog({ workId, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [detail, setDetail] = useState<WorkDetailDTO | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 打开时记录触发者（关闭后焦点返回）+ showModal
  useEffect(() => {
    if (!workId) return
    triggerRef.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null
    setDetail(null)
    setError(null)
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    const controller = new AbortController()
    api.getWorkDetail(workId, controller.signal)
      .then(d => setDetail(d))
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
    return () => controller.abort()
  }, [workId])

  const close = () => {
    dialogRef.current?.close()
    onClose()
    // 焦点返回触发按钮（dialog 原生行为把焦点丢给 body）
    triggerRef.current?.focus()
  }

  return (
    <dialog
      ref={dialogRef}
      className="m-auto p-0 bg-transparent backdrop:bg-stone-900/40 max-w-[min(92vw,720px)] w-full max-h-[86vh]"
      onClick={e => { if (e.target === dialogRef.current) close() }}
      onClose={onClose}
      data-testid="work-detail-dialog"
    >
      {workId && (
        <div className="bg-white rounded-2xl shadow-xl flex flex-col max-h-[86vh]" data-testid="work-detail-card">
          <div className="sticky top-0 bg-white/95 backdrop-blur px-5 py-4 border-b border-stone-100 flex items-start gap-3 rounded-t-2xl">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {detail && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-otter-100 text-otter-700 shrink-0">
                    {STATUS_LABELS[detail.work.status]}
                  </span>
                )}
                <span className="font-medium text-stone-800 truncate">{detail?.work.title ?? (error ? '工作不存在' : '加载中…')}</span>
              </div>
              <span className="font-mono text-xs text-stone-400">{workId}</span>
            </div>
            <button onClick={close} className="p-1.5 text-stone-400 hover:text-stone-600 shrink-0" data-testid="work-detail-close" aria-label="关闭">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="overflow-y-auto px-5 py-4 space-y-4">
            {error && (
              <div className="py-8 text-sm text-caramel-600 text-center" data-testid="work-detail-error">
                加载失败：{error}（可能已被清理）
              </div>
            )}

            {!error && !detail && <div className="py-8 text-sm text-stone-400 text-center">加载中…</div>}

            {detail && (
              <>
                {/* token 四分量主数字 + 金额参考态 */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2" data-testid="work-detail-tokens">
                  <div className="rounded-xl bg-otter-50 px-3 py-2">
                    <div className="text-xs text-stone-500">总 token</div>
                    <div className="text-lg font-semibold text-stone-800 tabular-nums">{fmtTokens(detail.tokens.totalTokens)}</div>
                  </div>
                  {([['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读'], ['cacheWrite', '缓存写']] as const).map(([k, label]) => (
                    <div key={k} className="rounded-xl bg-stone-50 px-3 py-2">
                      <div className="text-xs text-stone-500">{label}</div>
                      <div className="text-sm font-medium text-stone-700 tabular-nums">{fmtTokens(detail.tokens[k])}</div>
                    </div>
                  ))}
                </div>
                {!detail.pricingAvailable && (
                  <p className="text-xs text-stone-400" data-testid="work-detail-pricing">金额参考：未配置可信单价，不显示（不使用演示价格）</p>
                )}

                {/* 参与獭 */}
                <div>
                  <div className="text-xs font-semibold text-stone-500 mb-1.5">参与獭（{detail.participants.length}）</div>
                  <div className="flex flex-wrap gap-1.5" data-testid="work-detail-participants">
                    {detail.participants.map(p => (
                      <span key={p.otterId} className="px-2 py-0.5 rounded-full text-xs bg-lavender-100 text-lavender-700">
                        {p.otterId === 'unknown' ? '未知' : p.otterId.slice(0, 8)} · {p.invokeCount} 次
                      </span>
                    ))}
                  </div>
                </div>

                {/* 检视轮次：结构化留痕才计数，未记录显式说明 */}
                <div>
                  <div className="text-xs font-semibold text-stone-500 mb-1.5">检视 / 复核轮次</div>
                  {detail.work.reviewRounds.length === 0 ? (
                    <p className="text-xs text-stone-400" data-testid="work-detail-no-rounds">未记录（本工作期间无结构化轮次留痕）</p>
                  ) : (
                    <div className="space-y-1" data-testid="work-detail-rounds">
                      {detail.work.reviewRounds.map(r => (
                        <div key={r.roundNo} className="flex items-center gap-2 text-xs flex-wrap">
                          <span className="px-1.5 py-0.5 rounded bg-otter-100/70 text-stone-600 font-medium">第 {r.roundNo} 轮</span>
                          <span className="text-stone-600">{ROUND_STATE_LABELS[r.state]}</span>
                          <span className="text-stone-400 font-mono">{r.reviewerOtterId.slice(0, 8)}</span>
                          {r.passedAt && <span className="text-stone-400">{new Date(r.passedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' })} 通过</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* trace 绑定（证据链） */}
                <div>
                  <div className="text-xs font-semibold text-stone-500 mb-1.5">链绑定（{detail.traces.length}）</div>
                  <div className="space-y-0.5" data-testid="work-detail-traces">
                    {detail.traces.map(t => (
                      <div key={t.traceId} className="text-xs text-stone-500 font-mono flex gap-2 flex-wrap">
                        <span>{t.traceId.slice(0, 12)}…</span>
                        <span className="text-stone-400">{t.boundVia}</span>
                        <span className="text-stone-400">{t.boundAt.slice(0, 16).replace('T', ' ')}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 调用证据（最新在前） */}
                <div>
                  <div className="text-xs font-semibold text-stone-500 mb-1.5">调用证据（最新 {detail.invokeEvidence.length} 条）</div>
                  <div className="max-h-52 overflow-y-auto divide-y divide-stone-100 rounded-xl border border-stone-100" data-testid="work-detail-invokes">
                    {detail.invokeEvidence.map(ev => (
                      <div key={ev.invokeId} className="px-3 py-1.5 flex items-center gap-2 text-xs flex-wrap">
                        <span className="font-mono text-stone-500">{ev.otterId === 'unknown' ? '未知' : ev.otterId.slice(0, 8)}</span>
                        <span className="text-stone-400">{new Date(ev.startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' })}</span>
                        <span className="ml-auto tabular-nums text-stone-600">{fmtTokens(ev.tokens.totalTokens)} tok</span>
                        {!ev.hasUsage && <span className="px-1 rounded bg-caramel-50 text-caramel-600">usage 缺失</span>}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </dialog>
  )
}
