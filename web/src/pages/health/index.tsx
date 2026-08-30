import { useState, useEffect, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { RefreshCw, AlertTriangle, ShieldAlert, GitBranch, Activity, Bug, FileCode, TrendingUp, PieChart as PieIcon, Layers, BarChart3 } from 'lucide-react'
import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import '../../styles/globals.css'
import { AppLayout } from '../../components/AppLayout'
import { showToast } from '../../components/Toast'
import * as api from '../../api/client'
import type { RhiOverviewDTO, RhiSignalDTO, RhiChainDTO, RhiTrendsDTO, RhiCostOutputDTO, RhiCostOutputOtterDTO } from '../../api/client'

/**
 * F20260825rweb（#403）：RHI 健康面板页面（三视图）。
 * F20260829hviz：总览从静态数字卡升级为可视化看板——
 *   提交/BugFix 趋势折线图（30 天快照序列）、change_type 分布环形图、
 *   模块热区条形图、特性链五态分布堆叠条。
 * 数据源：scanOnce 已接入指标落库（Fix A）+ GET /api/health/trends。
 */

type Tab = 'overview' | 'signals' | 'chains' | 'cost'

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

const CHAIN_STATE_LABELS: Record<string, { label: string; className: string; color: string }> = {
  active: { label: '活跃', className: 'bg-emerald-100 text-emerald-700', color: '#10b981' },
  stalled: { label: '滞留', className: 'bg-status-stalled text-amber-700', color: '#f59e0b' },
  regressed: { label: '回退', className: 'bg-orange-100 text-orange-700', color: '#f97316' },
  zombie: { label: '僵尸', className: 'bg-rose-100 text-rose-700', color: '#f43f5e' },
  orphan: { label: '孤儿', className: 'bg-skeleton text-stone-500', color: '#a8a29e' },
}

const CHANGE_TYPE_COLORS = ['#0ea5e9', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6', '#14b8a6', '#f97316', '#64748b']
const CHANGE_TYPE_LABELS: Record<string, string> = {
  Feature: '新功能', BugFix: '修复', Refactor: '重构', Docs: '文档',
  Test: '测试', Chore: '杂务', Experiment: '实验',
}

const COST_OUTPUT_COLORS = ['#0ea5e9', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6', '#14b8a6', '#f97316', '#64748b', '#ec4899', '#06b6d4']

function HealthPage() {
  const [tab, setTab] = useState<Tab>('overview')
  const [overview, setOverview] = useState<RhiOverviewDTO | null>(null)
  const [trends, setTrends] = useState<RhiTrendsDTO | null>(null)
  const [signals, setSignals] = useState<RhiSignalDTO[]>([])
  const [chains, setChains] = useState<RhiChainDTO[]>([])
  const [stateCounts, setStateCounts] = useState<Record<string, number>>({})
  const [costOutput, setCostOutput] = useState<RhiCostOutputDTO | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const [ov, tr, sig, ch, co] = await Promise.all([
        api.getRhiOverview(signal),
        api.getRhiTrends(30, signal),
        api.getRhiSignals('open', signal),
        api.getRhiChains(signal),
        api.getRhiCostOutput(30, signal),
      ])
      if (signal?.aborted) return
      setOverview(ov)
      setTrends(tr)
      setSignals(sig.signals)
      setChains(ch.chains)
      setStateCounts(ch.stateCounts)
      setCostOutput(co)
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
      const res = r.result as { commitCount?: number; metricsStored?: number }
      showToast(
        r.ok ? `扫描完成：${res.commitCount ?? 0} commits · ${res.metricsStored ?? 0} 项指标入库` : '扫描失败',
        r.ok ? 'success' : 'error',
      )
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
          <div className="flex gap-1 p-1 rounded-full bg-skeleton/70 w-fit">
            {([
              { key: 'overview', label: `总览${overview ? ` · ${overview.openSignals}` : ''}` },
              { key: 'signals', label: `信号${signals.length ? ` · ${signals.length}` : ''}` },
              { key: 'chains', label: `特性链${chains.length ? ` · ${chains.length}` : ''}` },
              { key: 'cost', label: '成本/产出' },
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

          {/* 总览视图：指标卡 + 可视化看板 */}
          {tab === 'overview' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <MetricCard label="总提交（60 天窗口）" value={overview?.metrics.total_commits ?? '—'} icon={<GitBranch className="w-4 h-4" />} />
                <MetricCard label="BugFix 比率" value={fmtPercent(overview?.metrics.bugfix_ratio)} icon={<Bug className="w-4 h-4" />} />
                <MetricCard label="critical 信号" value={overview?.openSignalsBySeverity.critical ?? '—'} icon={<ShieldAlert className="w-4 h-4" />} tone={(overview?.openSignalsBySeverity.critical ?? 0) > 0 ? 'danger' : 'ok'} />
                <MetricCard label="warning 信号" value={overview?.openSignalsBySeverity.warning ?? '—'} icon={<AlertTriangle className="w-4 h-4" />} tone={(overview?.openSignalsBySeverity.warning ?? 0) > 0 ? 'warn' : 'ok'} />
              </div>

              {trends && trends.series.length > 0 ? (
                <>
                  {/* 趋势区：提交量 + BugFix 比率双图 */}
                  <ChartCard title="提交 & BugFix 趋势" subtitle="近 30 天快照 · 柱=提交数，线=BugFix 比率" icon={<TrendingUp className="w-4 h-4 text-otter-500" />}>
                    <ResponsiveContainer width="100%" height={220}>
                      <ComposedChart data={trends.series} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
                        <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fontSize: 11, fill: '#78716c' }} />
                        <YAxis yAxisId="left" tick={{ fontSize: 11, fill: '#78716c' }} />
                        <YAxis yAxisId="right" orientation="right" unit="%" tick={{ fontSize: 11, fill: '#78716c' }} domain={[0, 100]} />
                        <Tooltip labelFormatter={l => `快照 ${fmtDate(String(l))}`} />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar yAxisId="left" dataKey="total_commits" name="提交数" fill="#93c5fd" radius={[3, 3, 0, 0]} />
                        <Line yAxisId="right" type="monotone" dataKey="bugfix_ratio" name="BugFix 比率" stroke="#f43f5e" strokeWidth={2} dot={false} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </ChartCard>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* change_type 分布环形图 */}
                    <ChartCard title="提交类型分布" subtitle={`快照 ${trends.latestSnapshotDate ?? '—'} · 60 天窗口`} icon={<PieIcon className="w-4 h-4 text-otter-500" />}>
                      {changeTypeData(trends).length > 0 ? (
                        <ResponsiveContainer width="100%" height={220}>
                          <PieChart>
                            <Pie
                              data={changeTypeData(trends)}
                              dataKey="value"
                              nameKey="name"
                              cx="50%"
                              cy="50%"
                              innerRadius={55}
                              outerRadius={85}
                              paddingAngle={2}
                            >
                              {changeTypeData(trends).map((_, i) => (
                                <Cell key={i} fill={CHANGE_TYPE_COLORS[i % CHANGE_TYPE_COLORS.length]} />
                              ))}
                            </Pie>
                            <Tooltip />
                            <Legend wrapperStyle={{ fontSize: 12 }} />
                          </PieChart>
                        </ResponsiveContainer>
                      ) : (
                        <EmptyChart text="无分布数据" />
                      )}
                    </ChartCard>

                    {/* 模块热区条形图 */}
                    <ChartCard title="模块热区" subtitle="commit 按 module 聚合 · TOP 8" icon={<BarChart3 className="w-4 h-4 text-otter-500" />}>
                      {moduleData(trends).length > 0 ? (
                        <ResponsiveContainer width="100%" height={220}>
                          <ComposedChart data={moduleData(trends)} layout="vertical" margin={{ top: 5, right: 20, left: 10, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
                            <XAxis type="number" tick={{ fontSize: 11, fill: '#78716c' }} allowDecimals={false} />
                            <YAxis type="category" dataKey="name" width={80} tick={{ fontSize: 11, fill: '#78716c' }} />
                            <Tooltip />
                            <Bar dataKey="value" name="commits" fill="#0ea5e9" radius={[0, 3, 3, 0]} barSize={14} />
                          </ComposedChart>
                        </ResponsiveContainer>
                      ) : (
                        <EmptyChart text="无模块数据" />
                      )}
                    </ChartCard>
                  </div>

                  {/* 特性链五态分布堆叠条 */}
                  <ChartCard title="特性链五态分布" subtitle={`快照 ${trends.latestSnapshotDate ?? '—'} · 共 ${chainTotal(trends)} 条链`} icon={<Layers className="w-4 h-4 text-otter-500" />}>
                    <ChainStateBar counts={trends.distributions.chain_states ?? {}} />
                  </ChartCard>
                </>
              ) : (
                <div className="rounded-2xl bg-white/70 border border-stone-200/60 py-16 text-center">
                  <TrendingUp className="w-10 h-10 mx-auto mb-3 text-stone-300" />
                  <p className="text-sm text-stone-500">还没有历史快照——点右上角「立即扫描」生成第一份</p>
                  <p className="text-xs text-stone-400 mt-1">扫描会计算指标并写入快照库，之后每小时自动更新，趋势图逐日长出来</p>
                </div>
              )}
            </div>
          )}

          {/* 信号视图（列表为主，图表辅助） */}
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
              <div className="rounded-2xl bg-white/70 border border-stone-200/60 px-4 py-3">
                <ChainStateBar counts={stateCounts} />
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
          {/* 成本/产出视图 */}
          {tab === 'cost' && (
            <div className="space-y-4">
              {costOutput && costOutput.series.length > 0 ? (
                <>
                  {/* 汇总指标卡 */}
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                    <MetricCard label="总 Cost" value={`$${costOutput.totals.costTotal.toFixed(2)}`} icon={<TrendingUp className="w-4 h-4" />} />
                    <MetricCard label="总 Token" value={fmtLargeNumber(costOutput.totals.totalTokens)} icon={<BarChart3 className="w-4 h-4" />} />
                    <MetricCard label="LLM 调用" value={costOutput.totals.callCount} icon={<RefreshCw className="w-4 h-4" />} />
                    <MetricCard label="獭发言数" value={costOutput.totals.messageCount} icon={<GitBranch className="w-4 h-4" />} />
                    <MetricCard label="任务完成" value={costOutput.totals.dispatchCount} icon={<Layers className="w-4 h-4" />} />
                    <MetricCard label="活跃獭数" value={costOutput.totals.otterCount} icon={<Activity className="w-4 h-4" />} />
                  </div>

                  {/* Cost 趋势折线图 */}
                  <ChartCard title="成本趋势" subtitle="近 30 天 · 日 cost 合计" icon={<TrendingUp className="w-4 h-4 text-otter-500" />}>
                    <ResponsiveContainer width="100%" height={220}>
                      <ComposedChart data={costOutput.series} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
                        <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fontSize: 11, fill: '#78716c' }} />
                        <YAxis tick={{ fontSize: 11, fill: '#78716c' }} tickFormatter={v => `$${v.toFixed(2)}`} />
                        <Tooltip labelFormatter={l => `快照 ${fmtDate(String(l))}`} formatter={(v: number) => [`$${v.toFixed(4)}`, 'cost']} />
                        <Bar dataKey="costTotal" name="日 cost" fill="#0ea5e9" radius={[3, 3, 0, 0]} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </ChartCard>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Token 趋势折线图 */}
                    <ChartCard title="Token 消耗" subtitle="日 token 合计（input + output + cache）" icon={<BarChart3 className="w-4 h-4 text-otter-500" />}>
                      <ResponsiveContainer width="100%" height={220}>
                        <ComposedChart data={costOutput.series} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
                          <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fontSize: 11, fill: '#78716c' }} />
                          <YAxis tick={{ fontSize: 11, fill: '#78716c' }} tickFormatter={fmtLargeNumber} />
                          <Tooltip labelFormatter={l => `快照 ${fmtDate(String(l))}`} />
                          <Bar dataKey="totalTokens" name="总 Token" fill="#10b981" radius={[3, 3, 0, 0]} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </ChartCard>

                    {/* 缓存命中率趋势 */}
                    <ChartCard title="缓存命中率" subtitle="加权平均 · cacheRead / (cacheRead + input)" icon={<Activity className="w-4 h-4 text-otter-500" />}>
                      <ResponsiveContainer width="100%" height={220}>
                        <ComposedChart data={costOutput.series.map(p => ({ ...p, cacheHitRatePct: Number((p.cacheHitRate * 100).toFixed(2)) }))} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
                          <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fontSize: 11, fill: '#78716c' }} />
                          <YAxis tick={{ fontSize: 11, fill: '#78716c' }} domain={[0, 100]} unit="%" />
                          <Tooltip labelFormatter={l => `快照 ${fmtDate(String(l))}`} formatter={(v: number) => [`${v.toFixed(2)}%`, '命中率']} />
                          <Line type="monotone" dataKey="cacheHitRatePct" name="命中率" stroke="#f59e0b" strokeWidth={2} dot={false} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </ChartCard>
                  </div>

                  {/* Per-otter 明细表 */}
                  <ChartCard title="獭成本明细" subtitle={`最新快照 ${costOutput.latestSnapshotDate ?? '—'} · 按 cost 降序`} icon={<Layers className="w-4 h-4 text-otter-500" />}>
                    <div className="divide-y divide-stone-100">
                      {costOutput.otters.map(otter => (
                        <div key={otter.otterId} className="py-2.5">
                          <div className="flex items-center gap-3 text-sm">
                            <span className="font-medium text-stone-700 min-w-[120px]">{otter.otterName}</span>
                            <span className="px-2 py-0.5 rounded-full text-xs bg-skeleton text-stone-500">{otter.otterType}</span>
                            <span className="text-stone-500 text-xs ml-auto">
                              ${otter.costTotal.toFixed(4)} · {fmtLargeNumber(otter.totalTokens)} tok · {otter.callCount} 次
                            </span>
                            <span className="text-xs text-amber-600">命中 {(otter.cacheHitRate * 100).toFixed(1)}%</span>
                            <span className="text-xs text-stone-400">发言 {otter.messageCount}</span>
                          </div>
                          {otter.models.length > 1 && (
                            <div className="flex flex-wrap gap-2 mt-1 ml-2">
                              {otter.models.map(m => (
                                <span key={m.model} className="text-xs text-stone-400">
                                  {m.model}: ${m.costTotal.toFixed(4)} · {fmtLargeNumber(m.totalTokens)} tok
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                      {costOutput.otters.length === 0 && (
                        <div className="text-center py-12 text-stone-400">
                          <BarChart3 className="w-8 h-8 mx-auto mb-2 opacity-40" />
                          无成本/产出数据
                        </div>
                      )}
                    </div>
                  </ChartCard>

                  {/* Per-otter 成本占比堆叠条 */}
                  {costOutput.otters.length > 1 && (
                    <ChartCard title="獭成本占比" subtitle="各獭 cost 合计占比" icon={<PieIcon className="w-4 h-4 text-otter-500" />}>
                      <OtterCostBar otters={costOutput.otters} />
                    </ChartCard>
                  )}
                </>
              ) : (
                <div className="rounded-2xl bg-white/70 border border-stone-200/60 py-16 text-center">
                  <BarChart3 className="w-10 h-10 mx-auto mb-3 text-stone-300" />
                  <p className="text-sm text-stone-500">还没有成本/产出数据——点右上角「立即扫描」生成第一份</p>
                  <p className="text-xs text-stone-400 mt-1">扫描会解析 session JSONL 和消息表，写入 cost_output 快照</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  )
}

// ── 图表数据变换 ──

function fmtDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(5).replace('-', '/') : iso
}

function fmtPercent(v: number | undefined): string {
  return v === undefined ? '—' : `${(v * 100).toFixed(1)}%`
}

function changeTypeData(trends: RhiTrendsDTO): Array<{ name: string; value: number }> {
  const dist = trends.distributions.change_types
  if (!dist) return []
  return Object.entries(dist)
    .map(([k, v]) => ({ name: CHANGE_TYPE_LABELS[k] ?? k, value: v }))
    .sort((a, b) => b.value - a.value)
}

function moduleData(trends: RhiTrendsDTO): Array<{ name: string; value: number }> {
  const mods = trends.distributions.modules
  if (!Array.isArray(mods)) return []
  return mods.slice(0, 8).map(m => ({ name: m.module, value: m.count }))
}

function chainTotal(trends: RhiTrendsDTO): number {
  const cs = trends.distributions.chain_states
  return cs ? Object.values(cs).reduce((s, v) => s + v, 0) : 0
}

function stateRank(state: string): number {
  const order: Record<string, number> = { zombie: 5, regressed: 4, stalled: 3, orphan: 2, active: 1 }
  return order[state] ?? 0
}

// ── 组件 ──

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

function ChartCard({ title, subtitle, icon, children }: {
  title: string
  subtitle?: string
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="rounded-2xl bg-white/70 border border-stone-200/60 px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-stone-500 mb-0.5">
        {icon}
        <span className="font-semibold text-stone-600">{title}</span>
        {subtitle && <span className="text-stone-400">· {subtitle}</span>}
      </div>
      {children}
    </div>
  )
}

function EmptyChart({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center h-[220px] text-sm text-stone-400">{text}</div>
  )
}

/** 特性链五态分布：水平堆叠条（各态按占比分宽，hover 显示数值） */
function ChainStateBar({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, v]) => v > 0)
  const total = entries.reduce((s, [, v]) => s + v, 0)
  if (total === 0) {
    return <div className="flex items-center justify-center h-14 text-sm text-stone-400">无特性链数据</div>
  }
  return (
    <div>
      <div className="flex h-7 rounded-full overflow-hidden bg-skeleton/50">
        {entries.map(([state, count]) => {
          const cfg = CHAIN_STATE_LABELS[state]
          return (
            <div
              key={state}
              className="flex items-center justify-center transition-all"
              style={{ width: `${(count / total) * 100}%`, backgroundColor: cfg?.color ?? '#a8a29e' }}
              title={`${cfg?.label ?? state}: ${count}`}
            >
              {(count / total) >= 0.12 && (
                <span className="text-[11px] font-semibold text-white">{count}</span>
              )}
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
        {entries.map(([state, count]) => {
          const cfg = CHAIN_STATE_LABELS[state]
          return (
            <span key={state} className="flex items-center gap-1 text-xs text-stone-500">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: cfg?.color ?? '#a8a29e' }} />
              {cfg?.label ?? state} {count}（{((count / total) * 100).toFixed(0)}%）
            </span>
          )
        })}
      </div>
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

/** 大数字格式化：1234567 → 1.23M */
function fmtLargeNumber(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return String(v)
}

/** 獭成本占比堆叠条（同 ChainStateBar 模式） */
function OtterCostBar({ otters }: { otters: RhiCostOutputOtterDTO[] }) {
  const total = otters.reduce((s, o) => s + o.costTotal, 0)
  if (total === 0) {
    return <div className="flex items-center justify-center h-14 text-sm text-stone-400">无成本数据</div>
  }
  return (
    <div>
      <div className="flex h-7 rounded-full overflow-hidden bg-skeleton/50">
        {otters.map((otter, i) => (
          <div
            key={otter.otterId}
            className="flex items-center justify-center transition-all"
            style={{ width: `${(otter.costTotal / total) * 100}%`, backgroundColor: COST_OUTPUT_COLORS[i % COST_OUTPUT_COLORS.length] }}
            title={`${otter.otterName}: $${otter.costTotal.toFixed(4)}`}
          >
            {(otter.costTotal / total) >= 0.12 && (
              <span className="text-[11px] font-semibold text-white">${otter.costTotal.toFixed(2)}</span>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
        {otters.map((otter, i) => (
          <span key={otter.otterId} className="flex items-center gap-1 text-xs text-stone-500">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: COST_OUTPUT_COLORS[i % COST_OUTPUT_COLORS.length] }} />
            {otter.otterName} ${otter.costTotal.toFixed(4)}（{((otter.costTotal / total) * 100).toFixed(0)}%）
          </span>
        ))}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<HealthPage />)
