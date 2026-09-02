/**
 * 链详情抽屉（Issue #649 交付 3）：点泳道行 → 拉 #644 chainDetail → 展示全量
 * commits（sha/message/changeType/filesChanged）+ stateReason + 信号清单 + docTitle。
 *
 * F20260902sigm：docStatus 行删除（docStatus 退役），改显信号事实清单。
 * 泳道只画轻量节点（sha8+date+changeType），全量信息在此抽屉露出——
 * 单请求消费既有端点，不加新接口。
 */

import { useState, useEffect } from 'react'
import { X, FileCode } from 'lucide-react'
import * as api from '../../api/client'
import type { RhiChainDetailDTO } from '../../api/client'
import { OTTER } from './palette'
import { CHAIN_STATE_META, CHANGE_TYPE_LABELS, commitNodeColor } from './chain-state-meta'

/** 链路信号标签（F20260902sigm） */
const CHAIN_SIGNAL_LABELS: Record<string, string> = {
  'pr-stalled': 'PR 停滞',
  regressed: '质量回退',
  'doc-gap': '引用缺口',
}

/** 链详情侧滑抽屉：featureId=null 时不渲染 */
export function ChainDetailDrawer({ featureId, onClose }: { featureId: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<RhiChainDetailDTO | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDetail(null)
    setError(null)
    if (!featureId) return
    const ctrl = new AbortController()
    api.getRhiChainDetail(featureId, ctrl.signal)
      .then(res => setDetail(res.chain))
      .catch((err: unknown) => {
        if ((err as Error)?.name === 'AbortError') return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => ctrl.abort()
  }, [featureId])

  if (!featureId) return null
  const meta = detail ? CHAIN_STATE_META[detail.state] : undefined
  return (
    <div className="fixed inset-0 z-40 flex justify-end" data-testid="chain-drawer">
      {/* 遮罩：点击关闭 */}
      <div className="absolute inset-0 bg-stone-900/20" onClick={onClose} data-testid="chain-drawer-backdrop" />
      <div className="relative w-[480px] max-w-[90vw] h-full bg-white shadow-xl overflow-auto">
        <div className="sticky top-0 bg-white/95 backdrop-blur px-4 py-3 border-b border-stone-100 flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {meta && (
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${meta.className}`}>{meta.label}</span>
              )}
              <span className="font-medium text-stone-700 truncate">{detail?.docTitle ?? (error ? '—' : '加载中…')}</span>
            </div>
            <span className="font-mono text-xs text-stone-400">{featureId}</span>
          </div>
          <button onClick={onClose} className="p-1 text-stone-400 hover:text-stone-600 shrink-0" data-testid="chain-drawer-close" aria-label="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="px-4 py-8 text-sm text-caramel-600 text-center" data-testid="chain-drawer-error">
            加载失败：{error}
          </div>
        )}

        {!error && !detail && (
          <div className="px-4 py-8 text-sm text-stone-400 text-center">加载中…</div>
        )}

        {detail && (
          <div className="px-4 py-3 space-y-3" data-testid="chain-drawer-body">
            <p className="text-xs text-stone-500">{detail.stateReason}</p>
            <div className="flex items-center gap-3 text-xs text-stone-400 flex-wrap">
              <span>{detail.commitCount} commits · {detail.bugfixCount} bugfix</span>
              {detail.daysSinceLastCommit !== null && <span>距上次 {detail.daysSinceLastCommit} 天</span>}
            </div>
            {detail.signals.length > 0 && (
              <div className="flex flex-col gap-1" data-testid="chain-drawer-signals">
                {detail.signals.map(sig => (
                  <div key={sig.id} className="flex items-start gap-1.5 text-xs">
                    <span className={`shrink-0 px-1.5 py-0.5 rounded ${sig.id === 'regressed' ? 'bg-caramel-100 text-caramel-700' : sig.id === 'pr-stalled' ? 'bg-caramel-50 text-caramel-600' : 'bg-lavender-100 text-lavender-600'}`}>
                      {CHAIN_SIGNAL_LABELS[sig.id] ?? sig.id}
                    </span>
                    <span className="text-stone-500">{sig.evidence}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="border-t border-stone-100 pt-2">
              <div className="text-xs font-semibold text-stone-500 mb-1.5">commit 全序列（时间升序 · {detail.commits.length}）</div>
              <div className="divide-y divide-stone-100">
                {detail.commits.map(cm => (
                  <div key={cm.sha} className="py-2" data-testid="chain-drawer-commit">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: commitNodeColor(cm.changeType) }} />
                      <span className="font-mono text-xs text-stone-600">{cm.sha}</span>
                      <span className="text-xs text-stone-400">{cm.date.slice(0, 10)}</span>
                      {cm.changeType && (
                        <span className="px-1.5 py-0.5 rounded text-[11px] bg-otter-100/70 text-stone-500">
                          {CHANGE_TYPE_LABELS[cm.changeType] ?? cm.changeType}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-stone-600 mt-1 ml-4">{cm.message.split('\n')[0]}</p>
                    {cm.filesChanged.length > 0 && (
                      <p className="font-mono text-[11px] text-stone-400 mt-0.5 ml-4 truncate" title={cm.filesChanged.join('\n')}>
                        {cm.filesChanged.length} 文件 · {cm.filesChanged.slice(0, 3).join(', ')}
                      </p>
                    )}
                  </div>
                ))}
                {detail.commits.length === 0 && (
                  <div className="py-6 text-center text-xs text-stone-400 flex flex-col items-center gap-1">
                    <FileCode className="w-5 h-5 opacity-40" style={{ color: OTTER[300] }} />
                    无 commit 数据
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
