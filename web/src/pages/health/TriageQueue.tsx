/**
 * TriageQueue：RHI 信号处置队列（F20260917trig §4）。
 *
 * 「警报」页从「信号列表 + 建议你去看」改为「处置队列」：
 * - 未接单（triageStatus=null）置顶，按挂了几天降序，每条显示「open N 天」——N 越红越醒目
 * - 已归口折叠为一组，显示绑定 issue 链接 + triageNote +「triaged N 天」（D3 修订：
 *   让二期触发条件「triaged 超 14d ≥5 条」在面板上可观测）
 * - 修复中显示 issue + 状态
 * - 每条操作按钮：开 issue 处置 / 绑定已有 issue / 忽略（附理由）——写路径经
 *   POST /api/health/signals/:id/triage（与 agent 工具共享 repo.triage() 单一方法）
 *
 * 边界：总览/特性链/用量 tab 不动；本组件只管 signals tab 的处置队列视图。
 */

import { useState } from 'react'
import type { RhiSignalDTO } from '../../api/client'
import { triageRhiSignal } from '../../api/client'
import { showToast } from '../../components/Toast'

/** 从现在到 ISO 时间的天数（向上取整，最少 1） */
export function daysSince(iso: string, now = Date.now()): number {
  return Math.max(1, Math.ceil((now - Date.parse(iso)) / 86400000))
}

/** open N 天的颜色阶梯：≤3 灰 / 4-7 琥珀 / >7 玫瑰 */
function ageTone(days: number): string {
  if (days > 7) return 'text-rose-600 font-semibold'
  if (days > 3) return 'text-amber-600'
  return 'text-stone-400'
}

/** 单条信号卡的操作按钮组（开 issue / 绑定 / 忽略） */
function TriageActions({ signal, onDone }: { signal: RhiSignalDTO; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [showBind, setShowBind] = useState(false)
  const [showDismiss, setShowDismiss] = useState(false)
  const [issueNo, setIssueNo] = useState('')
  const [note, setNote] = useState('')

  const run = async (body: { action: 'bind_issue' | 'in_progress' | 'dismiss'; issueNumber?: number; note?: string }) => {
    setBusy(true)
    try {
      await triageRhiSignal(signal.id, body)
      showToast('处置已留痕', 'success')
      onDone()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '处置失败', 'error')
    } finally {
      setBusy(false)
      setShowBind(false)
      setShowDismiss(false)
    }
  }

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {!signal.triageStatus && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => { setShowBind(v => !v); setShowDismiss(false) }}
              className="px-2 py-0.5 rounded text-xs bg-otter-50 text-otter-600 border border-otter-200 hover:bg-otter-100 disabled:opacity-40"
            >
              开 issue / 绑定
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => { setShowDismiss(v => !v); setShowBind(false) }}
              className="px-2 py-0.5 rounded text-xs bg-stone-50 text-stone-500 border border-stone-200 hover:bg-stone-100 disabled:opacity-40"
            >
              忽略
            </button>
          </>
        )}
        {signal.triageStatus === 'triaged' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run({ action: 'in_progress' })}
            className="px-2 py-0.5 rounded text-xs bg-amber-50 text-amber-600 border border-amber-200 hover:bg-amber-100 disabled:opacity-40"
          >
            标为修复中
          </button>
        )}
      </div>
      {showBind && (
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            value={issueNo}
            onChange={e => setIssueNo(e.target.value)}
            placeholder="issue 编号"
            className="w-28 px-2 py-0.5 rounded border border-stone-200 text-xs"
          />
          <input
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="处置说明（可选）"
            className="flex-1 px-2 py-0.5 rounded border border-stone-200 text-xs"
          />
          <button
            type="button"
            disabled={busy || !issueNo}
            onClick={() => void run({ action: 'bind_issue', issueNumber: Number(issueNo), note: note || undefined })}
            className="px-2 py-0.5 rounded text-xs bg-otter-600 text-white disabled:opacity-40"
          >
            确认归口
          </button>
        </div>
      )}
      {showDismiss && (
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="忽略理由（必填——不处置必须是判断结论）"
            className="flex-1 px-2 py-0.5 rounded border border-stone-200 text-xs"
          />
          <button
            type="button"
            disabled={busy || !note.trim()}
            onClick={() => void run({ action: 'dismiss', note })}
            className="px-2 py-0.5 rounded text-xs bg-stone-600 text-white disabled:opacity-40"
          >
            确认忽略
          </button>
        </div>
      )}
    </div>
  )
}

/** 单条信号行（含处置状态徽章 + 操作区） */
function SignalRow({ signal, now, onChanged }: { signal: RhiSignalDTO; now: number; onChanged: () => void }) {
  const openDays = daysSince(signal.firstSeen, now)
  return (
    <div className="px-4 py-3" data-signal-id={signal.id}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium text-sm">{signal.signalTypeLabel}</span>
        {signal.featureId && <span className="font-mono text-xs text-stone-500">{signal.featureId}</span>}
        {signal.filePath && <span className="font-mono text-xs text-stone-500">{signal.filePath}</span>}
        <span className={`text-xs tabular-nums ${ageTone(openDays)}`}>open {openDays} 天</span>
        {signal.severity === 'critical'
          ? <span className="px-1.5 py-0.5 rounded text-xs bg-rose-50 text-rose-600 border border-rose-200">critical</span>
          : <span className="px-1.5 py-0.5 rounded text-xs bg-amber-50 text-amber-600 border border-amber-200">warning</span>}
        {signal.triageStatus === 'triaged' && signal.triagedAt && (
          <span className="px-1.5 py-0.5 rounded text-xs bg-stone-100 text-stone-600 border border-stone-200">
            已归口 {daysSince(signal.triagedAt, now)} 天
          </span>
        )}
        {signal.triageStatus === 'in_progress' && (
          <span className="px-1.5 py-0.5 rounded text-xs bg-amber-50 text-amber-700 border border-amber-200">修复中</span>
        )}
      </div>
      <p className="text-xs text-stone-500 mt-1">{signal.evidence}</p>
      {signal.suggestedAction && (
        <p className="text-xs text-otter-500 mt-0.5">建议：{signal.suggestedAction}</p>
      )}
      {signal.issueNumber && (
        <p className="text-xs mt-0.5">
          <a
            href={`https://github.com/chenlaicai/otter-buddy/issues/${signal.issueNumber}`}
            target="_blank"
            rel="noreferrer"
            className="text-otter-600 hover:underline"
          >
            → issue #{signal.issueNumber}
          </a>
        </p>
      )}
      {signal.triageNote && (
        <p className="text-xs text-stone-400 mt-0.5">处置说明:{signal.triageNote}</p>
      )}
      <TriageActions signal={signal} onDone={onChanged} />
    </div>
  )
}

/** 处置队列主组件：按处置状态分组渲染（§4 面板规格）。now 可注入供测试固定时间 */
export function TriageQueue({ signals, onChanged, now }: { signals: RhiSignalDTO[]; onChanged: () => void; now?: number }) {
  const nowMs = now ?? Date.now()
  const untriaged = signals
    .filter(s => s.triageStatus === null)
    // 未接单按挂了几天降序——first_seen 越早（挂越久）越靠前（§4：N 越红越醒目）
    .sort((a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen))
  const triaged = signals.filter(s => s.triageStatus === 'triaged')
  const inProgress = signals.filter(s => s.triageStatus === 'in_progress')

  return (
    <div className="space-y-4" data-testid="triage-queue">
      {untriaged.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-stone-600 mb-2">
            🔴 未接单 · {untriaged.length}（最上面挂最久）
          </h2>
          <div className="rounded-2xl bg-white/70 border border-stone-200/60 divide-y divide-stone-100">
            {untriaged.map(s => (
              <SignalRow key={s.id} signal={s} now={nowMs} onChanged={onChanged} />
            ))}
          </div>
        </div>
      )}
      {inProgress.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-stone-600 mb-2">🟡 修复中 · {inProgress.length}</h2>
          <div className="rounded-2xl bg-white/70 border border-stone-200/60 divide-y divide-stone-100">
            {inProgress.map(s => (
              <SignalRow key={s.id} signal={s} now={nowMs} onChanged={onChanged} />
            ))}
          </div>
        </div>
      )}
      {triaged.length > 0 && (
        <details className="rounded-2xl bg-white/70 border border-stone-200/60">
          <summary className="px-4 py-2.5 text-sm font-semibold text-stone-500 cursor-pointer select-none">
            ✅ 已归口 · {triaged.length}（点击展开）
          </summary>
          <div className="divide-y divide-stone-100 border-t border-stone-100">
            {triaged.map(s => (
              <SignalRow key={s.id} signal={s} now={nowMs} onChanged={onChanged} />
            ))}
          </div>
        </details>
      )}
      {untriaged.length === 0 && triaged.length === 0 && inProgress.length === 0 && (
        <div className="text-center py-12 text-stone-400" data-testid="triage-queue-empty">
          处置队列已清空
        </div>
      )}
    </div>
  )
}
