import { useState, useEffect, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { RefreshCw, AlertTriangle, ShieldAlert, GitBranch, Activity, Bug, FileCode } from 'lucide-react'
import '../../styles/globals.css'
import { AppLayout } from '../../components/AppLayout'
import { showToast } from '../../components/Toast'
import * as api from '../../api/client'
import type { RhiOverviewDTO, RhiSignalDTO, RhiChainDTO } from '../../api/client'

/**
 * F20260825rweb（#403）：RHI 健康面板页面。
 * 三视图一体：总览指标卡 + 信号列表（severity 分组）+ 特性链五态分布。
 * 量级分布参数（排序/分组）按真实数据到来后调整——先实现一版。
 */

type Tab = 'overview' | 'signals' | 'chains'

const SIGNAL_TYPE_LABELS: Record<string, string> = {
  bug_recurrence: 'bug 反复出现',
  chain_stall: '特性链滞留',
  hotspot: '热点文件',
  behavior_defect: '行为缺陷',
  eval_regression: '效果回退',
  intent_drop: '意图兑现率下降',
  hotspot_imbalance: '热区失衡',
  review_debt: '审视债务',
}

const CHAIN_STATE_LABELS: Record<string, { label: string; className: string }> = {
  active: { label: '活跃', className: 'bg-emerald-100 text-emerald-700' },
  stalled: { label: '滞留', className: 'bg-amber-100 text-amber-700' },
  regressed: { label: '回退', className: 'bg-orange-100 text-orange-700' },
  zombie: { label: '僵尸', className: 'bg-rose-100 text-rose-700' },
  orphan: { label: '孤儿', className: 'bg-stone-100 text-stone-500' },
}

function HealthPage() {
  const [tab, setTab] = useState<Tab>('overview')
  const [overview, setOverview] = useState<RhiOverviewDTO | null>(null)
  const [signals, setSignals] = useState<RhiSignalDTO[]>([])
  const [chains, setChains] = useState<RhiChainDTO[]>([])
  const [stateCounts, setStateCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const [ov, sig, ch] = await Promise.all([
        api.getRhiOverview(signal),
        api.getRhiSignals('open', signal),
        api.getRhiChains(signal),
      ])
      if (signal?.aborted) return
      setOverview(ov)
      setSignals(sig.signals)
      setChains(ch.chains)
      setStateCounts(ch.stateCounts)
    } catch (err) {
      if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) return
      showToast(err instanceof Error ? err.message : '加载失败', 'error')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    void refresh(ac.signal)
    return () => ac.abort()
  }, [refresh])

  const triggerScan = async () => {
    setLoading(true)
    try {
      const r = await api.triggerRhiScan()
      showToast(r.ok ? `扫描完成：${(r.result as { commitCount?: number }).commitCount ?? 0} commits` : '扫描失败', r.ok ? 'success' : 'error')
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '扫描失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  const criticalSignals = signals.filter(s => s.severity === 'critical')
  const warningSignals = signals.filter(s => s.severity !== 'critical')

  return (
    <AppLayout activeView="health">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
          {/* 头部：标题 + 操作 */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-stone-800 flex items-center gap-2">
                <Activity className="w-5 h-5 text-otter-500" />
                仓库健康面板
              </h1>
              {overview?.snapshotDate && (
                <p className="text-xs text-stone-500 mt-1">快照日期：{overview.snapshotDate}</p>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={triggerScan}
                disabled={loading}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-full bg-otter-500 text-white hover:bg-otter-600 disabled:opacity-50 transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                立即扫描
              </button>
            </div>
          </div>

          {/* Tab 切换 */}
          <div className="flex gap-1 p-1 rounded-full bg-stone-100/70 w-fit">
            {([
              { key: 'overview', label: `总览${overview ? ` · ${overview.openSignals}` : ''}` },
              { key: 'signals', label: `信号${signals.length ? ` · ${signals.length}` : ''}` },
              { key: 'chains', label: `特性链${chains.length ? ` · ${chains.length}` : ''}` },
            ] as { key: Tab; label: string }[]).map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-4 py-1.5 text-sm rounded-full transition-colors ${
                  tab === t.key ? 'bg-white text-otter-600 font-semibold shadow-sm' : 'text-stone-500 hover:text-stone-700'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* 总览视图 */}
          {tab === 'overview' && overview && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <MetricCard label="总提交" value={overview.metrics.total_commits ?? '—'} icon={<GitBranch className="w-4 h-4" />} />
                <MetricCard label="BugFix 比率" value={fmtPercent(overview.metrics.bugfix_ratio)} icon={<Bug className="w-4 h-4" />} />
                <MetricCard label="critical 信号" value={overview.openSignalsBySeverity.critical} icon={<ShieldAlert className="w-4 h-4" />} tone={overview.openSignalsBySeverity.critical > 0 ? 'danger' : 'ok'} />
                <MetricCard label="warning 信号" value={overview.openSignalsBySeverity.warning} icon={<AlertTriangle className="w-4 h-4" />} tone={overview.openSignalsBySeverity.warning > 0 ? 'warn' : 'ok'} />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <MetricCard label="合规提交" value={overview.metrics.compliant_commits ?? '—'} />
                <MetricCard label="有 FID 提交" value={overview.metrics.commits_with_fid ?? '—'} />
                <MetricCard label="BugFix 数" value={overview.metrics.bugfix_count ?? '—'} />
                <MetricCard label="FID 口径比率" value={fmtPercent(overview.metrics.bugfix_ratio_of_fid)} />
              </div>
            </div>
          )}

          {/* 信号视图 */}
          {tab === 'signals' && (
            <div className="space-y-4">
              {criticalSignals.length > 0 && (
                <SignalGroup title="🔴 严重信号（critical）" signals={criticalSignals} severity="critical" />
              )}
              <SignalGroup title="🟡 警告信号（warning）" signals={warningSignals} severity="warning" />
              {signals.length === 0 && (
                <div className="text-center py-12 text-stone-400">
                  <ShieldAlert className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  无开放信号
                </div>
              )}
            </div>
          )}

          {/* 特性链视图 */}
          {tab === 'chains' && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {Object.entries(CHAIN_STATE_LABELS).map(([state, cfg]) => (
                  <span key={state} className={`px-2.5 py-1 rounded-full text-xs font-medium ${cfg.className}`}>
                    {cfg.label} {stateCounts[state] ?? 0}
                  </span>
                ))}
              </div>
              <div className="rounded-2xl bg-white/70 border border-stone-200/60 divide-y divide-stone-100">
                {chains
                  .slice()
                  .sort((a, b) => stateRank(b.state) - stateRank(a.state) || (b.daysSinceLastCommit ?? 0) - (a.daysSinceLastCommit ?? 0))
                  .slice(0, 50)
                  .map(ch => (
                    <div key={ch.featureId} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${CHAIN_STATE_LABELS[ch.state]?.className ?? ''}`}>
                        {CHAIN_STATE_LABELS[ch.state]?.label ?? ch.state}
                      </span>
                      <span className="font-mono text-xs text-stone-600 shrink-0">{ch.featureId}</span>
                      <span className="text-xs text-stone-400 shrink-0">
                        {ch.commitCount} commits · {ch.bugfixCount} bugfix
                        {ch.daysSinceLastCommit !== null && ` · 距上次 ${ch.daysSinceLastCommit} 天`}
                      </span>
                      {ch.docStatus && <span className="text-xs text-stone-400 ml-auto shrink-0">{ch.docStatus}</span>}
                    </div>
                  ))}
                {chains.length === 0 && (
                  <div className="text-center py-12 text-stone-400">
                    <FileCode className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    无特性链数据
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  )
}

function fmtPercent(v: number | undefined): string {
  return v === undefined ? '—' : `${(v * 100).toFixed(1)}%`
}

function stateRank(state: string): number {
  const order: Record<string, number> = { zombie: 5, regressed: 4, stalled: 3, orphan: 2, active: 1 }
  return order[state] ?? 0
}

function MetricCard({ label, value, icon, tone = 'default' }: {
  label: string
  value: number | string
  icon?: React.ReactNode
  tone?: 'default' | 'ok' | 'warn' | 'danger'
}) {
  const toneClass = {
    default: 'text-stone-800',
    ok: 'text-emerald-600',
    warn: 'text-amber-600',
    danger: 'text-rose-600',
  }[tone]
  return (
    <div className="rounded-2xl bg-white/70 border border-stone-200/60 px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-stone-500 mb-1">
        {icon}
        {label}
      </div>
      <div className={`text-2xl font-bold ${toneClass}`}>{value}</div>
    </div>
  )
}

function SignalGroup({ title, signals, severity }: {
  title: string
  signals: RhiSignalDTO[]
  severity: 'critical' | 'warning'
}) {
  if (signals.length === 0 && severity === 'warning') return null
  return (
    <div>
      <h2 className="text-sm font-semibold text-stone-600 mb-2">{title} · {signals.length}</h2>
      <div className="rounded-2xl bg-white/70 border border-stone-200/60 divide-y divide-stone-100">
        {signals.map(s => (
          <div key={s.id} className="px-4 py-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm">{SIGNAL_TYPE_LABELS[s.signal_type] ?? s.signal_type}</span>
              {s.feature_id && <span className="font-mono text-xs text-stone-500">{s.feature_id}</span>}
              {s.file_path && <span className="font-mono text-xs text-stone-500">{s.file_path}</span>}
              {s.occurrences > 1 && (
                <span className="px-1.5 py-0.5 rounded text-xs bg-rose-50 text-rose-600">
                  复发 {s.occurrences} 次
                </span>
              )}
            </div>
            <p className="text-xs text-stone-500 mt-1">{s.evidence}</p>
            {s.suggested_action && (
              <p className="text-xs text-otter-500 mt-0.5">建议：{s.suggested_action}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<HealthPage />)
