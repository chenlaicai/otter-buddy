/**
 * F20260825rweb（#403）：RHI 健康面板页面（三视图）。
 * F20260829hviz：总览从静态数字卡升级为可视化看板。
 * F20260901 UI 重设计 PR2（Issue #647）：总览重组为「出血点仪表」——
 *   复发模式卡（首屏主角，bug●→fix● 交替时间轴）+ 低置信折叠抽屉 +
 *   热点热力条 + 趋势降 sparkline（可展开详情，数据不丢）+ 色彩 token 统一。
 *   #652 口径：confidence=low 不进 critical/warning 计数（数字与视觉折叠一致）。
 * 数据源：scanOnce 已接入指标落库（Fix A）+ GET /api/health/trends。
 */

import { useState, useEffect, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { RefreshCw, AlertTriangle, ShieldAlert, GitBranch, Activity, Bug, FileCode, TrendingUp, PieChart as PieIcon, Layers, BarChart3, Gauge, ArrowUpRight, ArrowDownRight, Minus, Flame } from 'lucide-react'
import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, Legend,
  PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, RadarChart as ReRadarChart,
} from 'recharts'
import '../../styles/globals.css'
import { AppLayout } from '../../components/AppLayout'
import { showToast } from '../../components/Toast'
import * as api from '../../api/client'
import type { RhiOverviewDTO, RhiSignalDTO, RhiChainDTO, RhiTrendsDTO, RhiCostOutputDTO, RhiCostOutputOtterDTO, RhiScoreDTO } from '../../api/client'
import { SERIES_COLORS, CHANGE_TYPE_COLORS, TEAL, CARAMEL, OTTER, LAVENDER } from './palette'
import { RecurrenceSection, LowConfidenceDrawer, FreqBadge, FanInExcludedList } from './RecurrenceCard'
import { HotspotHeatBar, TrendSparkline, hotspotData } from './HotspotHeat'

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
  post_merge_fix_density: '合并后修复密度',
}

/** 链五态（Issue #647 色彩纪律）：teal=活跃、caramel=滞留/回退、otter-300=僵尸/孤儿（失活降饱和，
 *  原 zombie rose 红退场——失活不是需要行动的紧急态）；徽章底色用 token +1A 透明后缀 */
const CHAIN_STATE_LABELS: Record<string, { label: string; className: string; color: string }> = {
  active: { label: '活跃', className: 'text-teal-700', color: TEAL[500] },
  stalled: { label: '滞留', className: 'text-caramel-600', color: CARAMEL[500] },
  regressed: { label: '回退', className: 'text-caramel-600', color: CARAMEL[600] },
  zombie: { label: '僵尸', className: 'text-stone-500', color: OTTER[300] },
  orphan: { label: '孤儿', className: 'text-lavender-500', color: LAVENDER[400] },
}

const CHANGE_TYPE_LABELS: Record<string, string> = {
  Feature: '新功能', BugFix: '修复', Refactor: '重构', Docs: '文档',
  Test: '测试', Chore: '杂务', Experiment: '实验',
}

const COST_OUTPUT_COLORS = SERIES_COLORS

/** 健康分状态色（issue #595：绿≥75 / 黄 50-74 / 红<50，与后端 statusFromScore 对齐）*/
const SCORE_STATUS_CONFIG: Record<string, { label: string; text: string; bg: string; border: string }> = {
  green: { label: '健康', text: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200' },
  yellow: { label: '观察', text: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200' },
  red: { label: '告警', text: 'text-rose-600', bg: 'bg-rose-50', border: 'border-rose-200' },
}

/** 五维度评分口径（与 health-score.ts 头注释保持一致） */
const DIMENSION_FORMULAS: Record<string, { formula: string; source: string }> = {
  D1: { formula: 'ratio ≤ 20% 满分，线性降至 40% 归零', source: 'bugfix 占比（快照行）' },
  D2: { formula: '100 − min(60, 热区文件数×4) − 失衡?20', source: '热区文件数 + bugfix:feature 失衡（分布）' },
  D3: { formula: 'active 占比×100 − regressed×150 − zombie×100', source: '五态计数（链状态分布）' },
  D4: { formula: '合规率×100（线性）', source: '合规提交数 / 总提交数（快照行）' },
  D5: { formula: '100 − (critical 密度×40 + warning 密度×30)', source: 'open 信号数 / 活跃链数（active+stalled）' },
}

/** 走向箭头（后端 TrendDirection：improving/stable/declining，不足 8 点 null）*/
export function TrendIcon({ direction }: { direction?: 'improving' | 'stable' | 'declining' | null }) {
  if (direction === 'improving') return <ArrowUpRight className="w-3.5 h-3.5 text-emerald-500" />
  if (direction === 'declining') return <ArrowDownRight className="w-3.5 h-3.5 text-rose-500" />
  if (direction === 'stable') return <Minus className="w-3.5 h-3.5 text-stone-400" />
  return <Minus className="w-3.5 h-3.5 text-stone-300" />
}

function HealthPage() {
  // Issue #647：支持 ?tab= 深链（刷新/截图/分享指定视图）；非法值回退 overview
  const initialTab = (['overview', 'signals', 'chains', 'cost'] as const).includes(new URLSearchParams(window.location.search).get('tab') as Tab) ? new URLSearchParams(window.location.search).get('tab') as Tab : 'overview'
  const [tab, setTab] = useState<Tab>(initialTab)
  const [overview, setOverview] = useState<RhiOverviewDTO | null>(null)
  const [trends, setTrends] = useState<RhiTrendsDTO | null>(null)
  const [signals, setSignals] = useState<RhiSignalDTO[]>([])
  const [chains, setChains] = useState<RhiChainDTO[]>([])
  const [stateCounts, setStateCounts] = useState<Record<string, number>>({})
  const [fanInExcluded, setFanInExcluded] = useState<Array<{ file: string; fanIn: number }>>([])
  const [costOutput, setCostOutput] = useState<RhiCostOutputDTO | null>(null)
  const [score, setScore] = useState<RhiScoreDTO | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const [ov, tr, sig, ch, co, sc] = await Promise.all([
        api.getRhiOverview(signal),
        api.getRhiTrends(30, signal),
        api.getRhiSignals('open', signal),
        api.getRhiChains(signal),
        api.getRhiCostOutput(30, false, signal),
        api.getRhiScore(signal),
      ])
      if (signal?.aborted) return
      setOverview(ov)
      setTrends(tr)
      setSignals(sig.signals)
      setChains(ch.chains)
      setStateCounts(ch.stateCounts)
      setFanInExcluded(ch.fanInExcludedFiles ?? [])
      setCostOutput(co)
      setScore(sc)
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

  // Issue #652：置信度三分——low 不进 critical/warning 组（后端计数口径同源），抽屉收纳
  const lowConfidenceSignals = signals.filter(s => s.confidence === 'low')
  const normalSignals = signals.filter(s => s.confidence !== 'low')
  const criticalSignals = normalSignals.filter(s => s.severity === 'critical')
  const warningSignals = normalSignals.filter(s => s.severity !== 'critical')

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

          {/* 总览视图：健康分卡 + 雷达图 + 出血点仪表（Issue #647 重组）*/}
          {tab === 'overview' && (
            <div className="space-y-4">
              {/* 健康分区：综合分大卡 + 五维雷达（issue #595 PR2，保留）*/}
              <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                <OverallScoreCard score={score} />
                <ScoreRadarCard score={score} />
              </div>

              {/* 洞察区（首屏主角）：复发模式卡 + 低置信折叠抽屉 */}
              <div className="rounded-2xl bg-white/70 border border-stone-200/60 px-4 py-3">
                <div className="flex items-center gap-1.5 text-xs text-stone-500 mb-2">
                  <ShieldAlert className="w-4 h-4 text-caramel-600" />
                  <span className="font-semibold text-stone-600">复发模式</span>
                  <span className="text-stone-400">· 同文件反复修 bug 的模式（首屏主角）</span>
                </div>
                <RecurrenceSection signals={signals.filter(s => s.signal_type === 'bug_recurrence')} />
                {/* Issue #652/#647：低置信信号默认折叠不稀释真警报；数字与折叠一致（后端同源口径）*/}
                <div className="mt-3">
                  <LowConfidenceDrawer signals={lowConfidenceSignals} />
                </div>
              </div>

              {/* 信号态势卡（原「critical/warning 裸数字」重组：构成 + 低置信单列）*/}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <MetricCard label="总提交（60 天窗口）" value={overview?.metrics.total_commits ?? '—'} icon={<GitBranch className="w-4 h-4" />} />
                <MetricCard label="BugFix 比率" value={fmtPercent(overview?.metrics.bugfix_ratio)} icon={<Bug className="w-4 h-4" />} />
                <MetricCard label="警报信号（critical）" value={overview?.openSignalsBySeverity.critical ?? '—'} icon={<ShieldAlert className="w-4 h-4" />} tone={(overview?.openSignalsBySeverity.critical ?? 0) > 0 ? 'danger' : 'ok'} />
                <MetricCard label="低置信待核" value={overview?.openSignalsByConfidence.low ?? '—'} icon={<AlertTriangle className="w-4 h-4" />} tone="default" />
              </div>

              {trends && trends.series.length > 0 ? (
                <>
                  {/* 热点文件热力条（项 3）：teal→caramel 热力映射 */}
                  <ChartCard title="热点文件" subtitle="按 30 天修改频次 · teal→caramel 热力映射" icon={<Flame className="w-4 h-4 text-caramel-500" />}>
                    <HotspotHeatBar hotspots={hotspotData(trends)} />
                  </ChartCard>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* change_type 分布环形图（色板 token 化）*/}
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
                              {changeTypeData(trends).map((entry, i) => (
                                <Cell key={i} fill={CHANGE_TYPE_COLORS[entry.name] ?? SERIES_COLORS[i % SERIES_COLORS.length]} />
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

                    {/* 模块热区条形图（色板 token 化）*/}
                    <ChartCard title="模块热区" subtitle="commit 按 module 聚合 · TOP 8" icon={<BarChart3 className="w-4 h-4 text-otter-500" />}>
                      {moduleData(trends).length > 0 ? (
                        <ResponsiveContainer width="100%" height={220}>
                          <ComposedChart data={moduleData(trends)} layout="vertical" margin={{ top: 5, right: 20, left: 10, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
                            <XAxis type="number" tick={{ fontSize: 11, fill: '#78716c' }} allowDecimals={false} />
                            <YAxis type="category" dataKey="name" width={80} tick={{ fontSize: 11, fill: '#78716c' }} />
                            <Tooltip />
                            <Bar dataKey="value" name="commits" fill={OTTER[300]} radius={[0, 3, 3, 0]} barSize={14} />
                          </ComposedChart>
                        </ResponsiveContainer>
                      ) : (
                        <EmptyChart text="无模块数据" />
                      )}
                    </ChartCard>
                  </div>

                  {/* 特性链五态分布堆叠条（色板 token 化）*/}
                  <ChartCard title="特性链五态分布" subtitle={`快照 ${trends.latestSnapshotDate ?? '—'} · 共 ${chainTotal(trends)} 条链`} icon={<Layers className="w-4 h-4 text-otter-500" />}>
                    <ChainStateBar counts={trends.distributions.chain_states ?? {}} />
                  </ChartCard>

                  {/* 趋势降 sparkline（项 4）：一行高度让位复发卡；点开展开完整趋势，数据不丢 */}
                  <TrendSparkline trends={trends} />
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
              {/* 信号说明卡 */}
              <div className="rounded-2xl bg-white/70 border border-stone-200/60 px-4 py-3">
                <p className="text-sm text-stone-600 font-semibold mb-1.5">信号 = 仓库异常模式自动检测</p>
                <p className="text-xs text-stone-500 leading-relaxed">
                  系统从提交记录、特性链、文件热区等数据中自动识别 8 种信号类型，反映潜在质量风险。open 状态表示待处置，建议关注 critical 级别信号。
                </p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {Object.values(SIGNAL_TYPE_LABELS).map(label => (
                    <span key={label} className="px-2 py-0.5 rounded-full text-xs bg-stone-100 text-stone-600">{label}</span>
                  ))}
                </div>
              </div>

              {criticalSignals.length > 0 && (
                <SignalGroup title="🔴 严重信号（critical）" signals={criticalSignals} severity="critical" />
              )}
              <SignalGroup title="🟡 警告信号（warning）" signals={warningSignals} severity="warning" />
              {/* Issue #652：低置信单列（不与主警报等权），默认折叠；18 条假警报不稀释真警报 */}
              {lowConfidenceSignals.length > 0 && (
                <LowConfidenceDrawer signals={lowConfidenceSignals} />
              )}
              {normalSignals.length === 0 && lowConfidenceSignals.length === 0 && (
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
                {/* Issue #647：高扇入排除清单可见不黑箱（合并后修复密度信号的边界一）*/}
                <FanInExcludedList files={fanInExcluded} />
              </div>
              <div className="rounded-2xl bg-white/70 border border-stone-200/60 divide-y divide-stone-100">
                {chains
                  .slice()
                  .sort((a, b) => stateRank(b.state) - stateRank(a.state) || (b.daysSinceLastCommit ?? 0) - (a.daysSinceLastCommit ?? 0))
                  .slice(0, 50)
                  .map(ch => (
                    <div key={ch.featureId} className="px-4 py-2.5 text-sm">
                      <div className="flex items-center gap-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${CHAIN_STATE_LABELS[ch.state]?.className ?? ''}`}>
                          {CHAIN_STATE_LABELS[ch.state]?.label ?? ch.state}
                        </span>
                        <span className="font-medium text-stone-700 truncate">
                          {ch.docTitle ?? '无文档'}
                        </span>
                        <span className="font-mono text-xs text-stone-400 shrink-0">{ch.featureId}</span>
                        <span className="text-xs text-stone-400 shrink-0 ml-auto">
                          {ch.commitCount} commits · {ch.bugfixCount} bugfix
                          {ch.daysSinceLastCommit !== null && ` · 距上次 ${ch.daysSinceLastCommit} 天`}
                        </span>
                      </div>
                      <p className="text-xs text-stone-500 mt-1 ml-14">{ch.stateReason}</p>
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
                        <Bar dataKey="costTotal" name="日 cost" fill={TEAL[500]} radius={[3, 3, 0, 0]} />
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
                          <Bar dataKey="totalTokens" name="总 Token" fill={OTTER[300]} radius={[3, 3, 0, 0]} />
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
                          <Line type="monotone" dataKey="cacheHitRatePct" name="命中率" stroke={CARAMEL[500]} strokeWidth={2} dot={false} />
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

/** 综合健康分大卡：大数字 + 状态色 + 走向箭头 + 归因句（issue #595 PR2 核心交付）*/
function OverallScoreCard({ score }: { score: RhiScoreDTO | null }) {
  const [showFormula, setShowFormula] = useState(false)
  if (!score || !score.available || score.overall === null) {
    return (
      <div className="md:col-span-2 rounded-2xl bg-white/70 border border-stone-200/60 px-5 py-4 flex items-center gap-3">
        <Gauge className="w-8 h-8 text-stone-300" />
        <div>
          <div className="text-sm font-semibold text-stone-600">综合健康分</div>
          <div className="text-xs text-stone-400 mt-0.5">扫描后生成（需连续 8 天数据出走向）</div>
        </div>
      </div>
    )
  }
  const cfg = SCORE_STATUS_CONFIG[score.overallStatus ?? 'yellow'] ?? SCORE_STATUS_CONFIG.yellow
  return (
    <div className={`md:col-span-2 rounded-2xl ${cfg.bg} border ${cfg.border} px-5 py-4 flex items-center gap-4`}>
      <div className="flex flex-col items-center">
        <div className={`text-5xl font-bold tabular-nums ${cfg.text}`}>{Math.round(score.overall)}</div>
        <div className="flex items-center gap-1 mt-1">
          <TrendIcon direction={score.trend.overall} />
          <span className="text-xs text-stone-400">走向</span>
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-stone-700">综合健康分</span>
          <button
            onClick={() => setShowFormula(v => !v)}
            className="w-4 h-4 rounded-full bg-white/60 text-stone-500 flex items-center justify-center hover:bg-white/80 transition-colors"
            title="查看综合分计算方式"
          >
            <span className="text-[10px] font-bold">?</span>
          </button>
          <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${cfg.text} bg-white/60`}>{cfg.label}</span>
        </div>
        {showFormula && (
          <div className="mt-1.5 p-2 rounded-lg bg-white/50 text-xs text-stone-600">
            综合分 = Σ(维度分 × 权重) / Σ(有数据维度权重)。无数据维度不参与加权，权重自动归一。
          </div>
        )}
        <p className="text-xs text-stone-500 mt-1.5 leading-relaxed">
          {score.attribution ?? '五维均无拖累'}
        </p>
        <div className="flex gap-1.5 mt-2 flex-wrap">
          {score.dimensions.map(d => {
            const dcfg = SCORE_STATUS_CONFIG[d.status ?? 'yellow'] ?? SCORE_STATUS_CONFIG.yellow
            return (
              <span key={d.dimension} className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${dcfg.text} bg-white/50`} title={d.name}>
                {d.name} {d.score === null ? '—' : Math.round(d.score)}
              </span>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** 五维雷达图（issue #595 PR2）：无数据维度以 0 呈现并在图例标注「无数据」*/
function ScoreRadarCard({ score }: { score: RhiScoreDTO | null }) {
  const [showFormula, setShowFormula] = useState(false)
  if (!score || !score.available || score.dimensions.length === 0) {
    return (
      <div className="md:col-span-3 rounded-2xl bg-white/70 border border-stone-200/60 flex items-center justify-center h-[200px] text-sm text-stone-400">
        五维雷达待扫描生成
      </div>
    )
  }
  const radarData = score.dimensions.map(d => ({
    dim: d.name,
    score: d.score ?? 0,
    noData: d.score === null,
  }))
  return (
    <div className="md:col-span-3 rounded-2xl bg-white/70 border border-stone-200/60 px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-stone-500 mb-0.5">
        <Gauge className="w-4 h-4 text-otter-500" />
        <span className="font-semibold text-stone-600">五维雷达</span>
        <button
          onClick={() => setShowFormula(v => !v)}
          className="w-4 h-4 rounded-full bg-stone-200 text-stone-500 flex items-center justify-center hover:bg-stone-300 transition-colors"
          title="查看评分公式"
        >
          <span className="text-[10px] font-bold">?</span>
        </button>
        <span className="text-stone-400">· 快照 {score.snapshotDate ?? '—'}</span>
      </div>
      {showFormula && (
        <div className="mb-2 p-2.5 rounded-lg bg-stone-50 border border-stone-200/60 text-xs text-stone-600 space-y-1.5">
          <p className="font-medium text-stone-700 mb-1">综合分 = Σ(维度分 × 权重) / Σ(有数据维度权重)</p>
          {score.dimensions.map(d => {
            const f = DIMENSION_FORMULAS[d.dimension]
            if (!f) return null
            return (
              <div key={d.dimension} className="flex gap-2">
                <span className="font-mono font-semibold shrink-0 w-6">{d.dimension}</span>
                <span className="shrink-0">{d.name}：</span>
                <span className="text-stone-500">{f.formula}（{f.source}）</span>
              </div>
            )
          })}
          <p className="text-stone-400 italic">状态：绿 ≥75 / 黄 50-74 / 红 &lt;50</p>
        </div>
      )}
      <ResponsiveContainer width="100%" height={200}>
        <ReRadarChart data={radarData} outerRadius="75%">
          <PolarGrid stroke="#e7e5e4" />
          <PolarAngleAxis dataKey="dim" tick={{ fontSize: 11, fill: '#78716c' }} />
          <PolarRadiusAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#a8a29e' }} angle={90} />
          <Radar name="健康分" dataKey="score" stroke={TEAL[500]} fill={TEAL[500]} fillOpacity={0.25} />
          <Tooltip formatter={(v: number | string, _n, item) => {
            const noData = (item?.payload as { noData?: boolean })?.noData
            return [noData ? '无数据' : v, '健康分']
          }} />
        </ReRadarChart>
      </ResponsiveContainer>
      <div className="flex justify-center gap-3 -mt-1">
        {score.dimensions.map(d => {
          const dcfg = SCORE_STATUS_CONFIG[d.status ?? 'yellow'] ?? SCORE_STATUS_CONFIG.yellow
          return (
            <span key={d.dimension} className="flex items-center gap-1 text-[11px] text-stone-500">
              <TrendIcon direction={score.trend[d.dimension]} />
              <span className={dcfg.text}>{d.name}</span>
            </span>
          )
        })}
      </div>
    </div>
  )
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
              style={{ width: `${(count / total) * 100}%`, backgroundColor: cfg?.color ?? OTTER[300] }}
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
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: cfg?.color ?? OTTER[300] }} />
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
              <span className="font-medium text-sm">{s.signalTypeLabel}</span>
              {s.feature_id && <span className="font-mono text-xs text-stone-500">{s.feature_id}</span>}
              {s.file_path && <span className="font-mono text-xs text-stone-500">{s.file_path}</span>}
              {/* 频次徽章（检视建议 5）：bug_recurrence 走证据序列长度与复发卡同源，rose 退场 */}
              <FreqBadge signal={s} />
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
