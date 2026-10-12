/**
 * F20261012qtbc：配额看板（健康面板「配额」Tab）。
 *
 * 三列账号卡，按各家真实窗口形态渲染（GLM 5h+周、Kimi 5h+7日、MiMo 单余量——
 * 窗口数量由后端 windows[] 决定，前端不硬凑）。
 *
 * 边界（搭档拍板 2026-10-12）：纯展示——无通知开关、不进观测数据；
 * 「告警」只有视觉状态：余量条变色 + 耗尽字样 + 重置时间。
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { RefreshCw, LogIn, Gauge } from 'lucide-react'
import * as api from '../../api/client'
import type { ProviderQuotaDTO, QuotaWindowDTO } from '../../api/client'
import { showToast } from '../../components/Toast'

/** 余量比例 → 条色（≥50% 绿 / ≥20% 橙 / 以下红） */
function barColor(ratio: number | null, exhausted: boolean): string {
  if (exhausted) return 'bg-rose-500'
  if (ratio === null) return 'bg-stone-300'
  if (ratio >= 0.5) return 'bg-emerald-500'
  if (ratio >= 0.2) return 'bg-amber-500'
  return 'bg-rose-500'
}

function formatNum(n: number | null): string {
  if (n === null) return '—'
  return n.toLocaleString('zh-CN')
}

function formatReset(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = Date.now()
  const diff = d.getTime() - now
  const abs = (v: number) => `${v < 0 ? '-' : ''}`
  const hh = Math.floor(Math.abs(diff) / 3_600_000)
  const mm = Math.floor((Math.abs(diff) % 3_600_000) / 60_000)
  const when = `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return diff >= 0 ? `⏱ ${when} 重置（剩 ${hh}h${mm}m）` : `⏱ ${when} 重置${abs(diff)}`
}

function isExhausted(w: QuotaWindowDTO): boolean {
  return w.remaining === 0 || (w.remainingRatio !== null && w.remainingRatio <= 0)
}

function WindowRow({ w }: { w: QuotaWindowDTO }) {
  const exhausted = isExhausted(w)
  const ratio = w.remainingRatio
  const widthPct = exhausted ? 100 : ratio !== null ? Math.round(ratio * 100) : 100
  return (
    <div className="mt-3" data-testid={`quota-window-${w.key}`}>
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-stone-500">{w.label}</span>
        {exhausted ? (
          <span className="text-xs font-semibold text-rose-600">耗尽</span>
        ) : (
          <span className="text-xs text-stone-600">
            剩 {ratio !== null ? `${Math.round(ratio * 100)}%` : '—'}
            {w.remaining !== null ? ` · ${formatNum(w.remaining)}` : ''}
          </span>
        )}
      </div>
      <div className="h-2 mt-1 rounded-full bg-stone-100 overflow-hidden">
        <div
          className={`h-full rounded-full ${barColor(ratio, exhausted)}`}
          style={{ width: `${widthPct}%` }}
          data-testid={`quota-bar-${w.key}`}
        />
      </div>
      <div className="flex items-baseline justify-between mt-1">
        <span className="text-[10px] text-stone-400">
          已用 {formatNum(w.used)}{w.limit !== null ? ` / ${formatNum(w.limit)}` : ''}
        </span>
        <span className="text-[10px] text-stone-400">{formatReset(w.resetAt)}</span>
      </div>
    </div>
  )
}

function ProviderCard({ p, onLogin, onRefresh }: {
  p: ProviderQuotaDTO
  onLogin: (provider: ProviderQuotaDTO['provider']) => void
  onRefresh: () => void
}) {
  return (
    <div className="flex-1 min-w-[220px] rounded-xl border border-stone-200 bg-white p-4" data-testid={`quota-card-${p.provider}`}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold text-stone-800">{p.label}</div>
        {p.status === 'ok' && <span className="text-[10px] text-stone-400">{new Date(p.fetchedAt).toLocaleTimeString('zh-CN')}</span>}
        {p.status === 'needs-login' && <span className="text-[10px] font-semibold text-amber-600">需登录</span>}
        {p.status === 'error' && <span className="text-[10px] font-semibold text-rose-600">采集失败</span>}
      </div>
      {p.status === 'ok' && p.windows.map(w => <WindowRow key={w.key} w={w} />)}
      {p.status === 'needs-login' && (
        <div className="mt-3">
          <p className="text-xs text-stone-500">{p.error ?? '登录态缺失或过期'}</p>
          <button
            onClick={() => onLogin(p.provider)}
            className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full bg-otter-500 text-white hover:bg-otter-600 transition-colors"
            data-testid={`quota-login-${p.provider}`}
          >
            <LogIn className="w-3 h-3" />
            扫码登录
          </button>
        </div>
      )}
      {p.status === 'error' && (
        <div className="mt-3">
          <p className="text-xs text-stone-500">{p.error ?? '采集失败'}</p>
          <button
            onClick={onRefresh}
            className="mt-2 px-3 py-1.5 text-xs rounded-full border border-stone-200 text-stone-600 hover:bg-stone-50 transition-colors"
          >
            重试
          </button>
        </div>
      )}
    </div>
  )
}

export function QuotaBoard() {
  const [snapshot, setSnapshot] = useState<api.QuotaSnapshotDTO | null>(null)
  const [loading, setLoading] = useState(false)
  const timerRef = useRef<number | null>(null)

  const load = useCallback(async (refresh: boolean, signal?: AbortSignal) => {
    setLoading(true)
    try {
      const snap = await api.getQuota(refresh, signal)
      if (!signal?.aborted) setSnapshot(snap)
    } catch (err) {
      if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) return
      showToast(err instanceof Error ? err.message : '配额加载失败', 'error')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    void load(false, ac.signal)
    // 5 分钟自动刷新（纯展示轮询，不进观测数据）
    timerRef.current = window.setInterval(() => { void load(false) }, 5 * 60_000)
    return () => {
      ac.abort()
      if (timerRef.current !== null) window.clearInterval(timerRef.current)
    }
  }, [load])

  const onLogin = async (provider: ProviderQuotaDTO['provider']) => {
    showToast('浏览器窗口即将弹出，请在窗口内扫码登录（关窗即完成）', 'info')
    try {
      await api.triggerQuotaLogin(provider)
      await load(true)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '登录失败', 'error')
    }
  }

  return (
    <div className="space-y-4" data-testid="quota-board">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-stone-800 flex items-center gap-2">
            <Gauge className="w-4 h-4 text-otter-500" />
            账号配额（控制台实时数据）
          </h2>
          <p className="text-xs text-stone-400 mt-0.5">
            5 分钟自动刷新 · 仅展示，不参与系统调度{snapshot?.stale ? ' · 含缓存数据' : ''}
          </p>
        </div>
        <button
          onClick={() => void load(true)}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-full border border-stone-200 text-stone-600 hover:bg-stone-50 disabled:opacity-50 transition-colors"
          data-testid="quota-refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>
      <div className="flex flex-wrap gap-4">
        {(snapshot?.providers ?? []).map(p => (
          <ProviderCard key={p.provider} p={p} onLogin={onLogin} onRefresh={() => void load(true)} />
        ))}
        {!snapshot && (
          <div className="text-sm text-stone-400 py-8 w-full text-center">加载中…</div>
        )}
      </div>
    </div>
  )
}

export default QuotaBoard
