/**
 * F20260825rweb（#403）：RHI 健康面板页面（三视图）。
 * F20260829hviz：总览从静态数字卡升级为可视化看板。
 * F20260901 UI 重设计 PR2（Issue #647）：总览重组为「出血点仪表」——
 *   复发模式卡（首屏主角，bug●→fix● 交替时间轴）+ 低置信折叠抽屉 +
 *   热点热力条 + 趋势降 sparkline（可展开详情，数据不丢）+ 色彩 token 统一。
 *   #652 口径：confidence=low 不进 critical/warning 计数（数字与视觉折叠一致）。
 * Issue #1029（F20260917hpui）：总览页三层重组——判断（归因句升主标题）→
 *   五维大白话条形（点开展开证据层，原料数据收编下钻）→ 建议动作。
 *   砍掉：模块热区条形图、四张重复指标卡、平铺热点图/环形图/四态条（原料
 *   全部收编进对应维度证据层）。tab 改名：信号→警报、特性链→进行中的事。
 * 数据源：scanOnce 已接入指标落库（Fix A）+ GET /api/health/trends。
 */

import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, AlertTriangle, ShieldAlert, GitBranch, Activity, TrendingUp, PieChart as PieIcon, Layers, BarChart3 } from 'lucide-react'
import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import * as api from '../../api/client'
import { showToast } from '../../components/Toast'
import type { RhiOverviewDTO, RhiSignalDTO, RhiChainDTO, RhiTrendsDTO, RhiCostOutputDTO, RhiScoreDTO } from '../../api/client'
import { SERIES_COLORS, CARAMEL, OTTER } from './palette'
import { RecurrenceSection, LowConfidenceDrawer, FanInExcludedList } from './RecurrenceCard'
import { TrendSparkline } from './HotspotHeat'
import { ChainFilterChips } from './SwimlaneTimeline'
import { ChainDetailDrawer } from './ChainDetailDrawer'
import { TriageQueue } from './TriageQueue'
import { type ChainState } from './chain-state-meta'
import { VerdictCard, DimensionRows, ActionList } from './VerdictPanel'
import { ChainsPanel } from './ChainsPanel'

type Tab = 'overview' | 'signals' | 'chains' | 'cost'

/** tab 显示名（issue #1029：信号→警报、特性链→进行中的事——内部术语翻译成搭档语言） */
const TAB_LABELS: Record<Tab, string> = {
  overview: '总览',
  signals: '警报',
  chains: '进行中的事',
  cost: '用量/效率',
}

const COST_OUTPUT_COLORS = SERIES_COLORS

export default function HealthPage() {
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
  // Issue #649 PR3：泳道异常筛选 + 抽屉选中链
  const [chainFilter, setChainFilter] = useState<ChainState | null>(null)
  const [activeChainId, setActiveChainId] = useState<string | null>(null)
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
      // #581：后端失败改返 500，此处只处理成功路径（失败进 catch）
      showToast(`扫描完成：${res.commitCount ?? 0} commits · ${res.metricsStored ?? 0} 项指标入库`, 'success')
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '扫描失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  // Issue #652：置信度三分——low 不进 critical/warning 组（后端计数口径同源），抽屉收纳
  // F20260917trig：signals tab 改处置队列——按处置状态分组（TriageQueue 内部三分），
  // severity 分组退居组件内部徽章；low 置信仍折叠（不稀释真警报）
  const lowConfidenceSignals = signals.filter(s => s.confidence === 'low')
  const normalSignals = signals.filter(s => s.confidence !== 'low')
  // issue #1029：D5 证据 + 建议动作链路——「警报」页未接单信号数（triage 字段，F20260917trig）
  // #652 口径同源：low 置信不进未接单计数（与警报 tab 分组一致）
  const untriagedCount = signals.filter(s => s.triageStatus === null && s.confidence !== 'low').length

  return (
    <>
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
              { key: 'overview', label: `${TAB_LABELS.overview}${overview ? ` · ${overview.openSignals}` : ''}` },
              { key: 'signals', label: `${TAB_LABELS.signals}${signals.length ? ` · ${signals.length}` : ''}` },
              { key: 'chains', label: `${TAB_LABELS.chains}${chains.length ? ` · ${chains.length}` : ''}` },
              { key: 'cost', label: TAB_LABELS.cost },
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

          {/* 总览视图（issue #1029 三层结构）：判断 → 五维（点开展证据）→ 建议动作；
              复发模式卡保留（首屏洞察主角）；原料数据（环形图/热区/四态）收编进维度证据层 */}
          {tab === 'overview' && (
            <div className="space-y-4">
              {/* 第一层：判断——归因句升主标题 */}
              <VerdictCard score={score} />

              {/* 第二层：五维大白话条形，点红色看原因（证据层收编原料数据） */}
              <DimensionRows
                score={score}
                trends={trends}
                overview={overview}
                untriagedCount={untriagedCount}
              />

              {/* 洞察区：复发模式卡（同文件反复修 bug——首屏主角，#647 保留）+ 低置信折叠抽屉 */}
              <div className="rounded-2xl bg-white/70 border border-stone-200/60 px-4 py-3">
                <div className="flex items-center gap-1.5 text-xs text-stone-500 mb-2">
                  <ShieldAlert className="w-4 h-4 text-caramel-600" />
                  <span className="font-semibold text-stone-600">复发模式</span>
                  <span className="text-stone-400">· 同文件反复修 bug 的模式</span>
                </div>
                <RecurrenceSection signals={signals.filter(s => s.signal_type === 'bug_recurrence')} />
                {/* Issue #652/#647：低置信信号默认折叠不稀释真警报；数字与折叠一致（后端同源口径）*/}
                <div className="mt-3">
                  <LowConfidenceDrawer signals={lowConfidenceSignals} />
                </div>
              </div>

              {/* 第三层：处置——红/黄维度各配建议动作（链到「警报」处置队列） */}
              <ActionList score={score} untriagedCount={untriagedCount} />

              {/* 趋势 sparkline（#647 项 4 保留）：一行高度，点开展开完整趋势，数据不丢 */}
              {trends && trends.series.length > 0 && <TrendSparkline trends={trends} />}

              {(!trends || trends.series.length === 0) && (
                <div className="rounded-2xl bg-white/70 border border-stone-200/60 py-16 text-center">
                  <TrendingUp className="w-10 h-10 mx-auto mb-3 text-stone-300" />
                  <p className="text-sm text-stone-500">还没有历史快照——点右上角「立即扫描」生成第一份</p>
                  <p className="text-xs text-stone-400 mt-1">扫描会计算指标并写入快照库，之后每小时自动更新，趋势图逐日长出来</p>
                </div>
              )}
            </div>
          )}

          {/* 信号视图（F20260917trig §4：处置队列——按处置状态分组，操作按钮可执行） */}
          {tab === 'signals' && (
            <div className="space-y-4">
              {/* 处置队列说明卡 */}
              <div className="rounded-2xl bg-white/70 border border-stone-200/60 px-4 py-3">
                <p className="text-sm text-stone-600 font-semibold mb-1.5">警报处置队列</p>
                <p className="text-xs text-stone-500 leading-relaxed">
                  每条警报有处置状态：未接单（置顶，挂越久越红）→ 已归口（绑定 issue）→ 修复中 → 终态。
                  处置动作会写库留痕，日报獭的对账公式 M+K+D=N 从这些数据自动生成。
                </p>
              </div>

              {normalSignals.length > 0 && (
                <TriageQueue signals={normalSignals} onChanged={() => void refresh()} />
              )}
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

          {/* 特性链视图（issue #1029 改名「进行中的事」+ 进度语言分组折叠；
              泳道组件 SwimlaneTimeline 本体不重写——ChainsPanel 只分组折叠；
              筛选 chips + 详情抽屉保留（Issue #649）*/}
          {tab === 'chains' && (
            <div className="space-y-4">
              <div className="rounded-2xl bg-white/70 border border-stone-200/60 px-4 py-3">
                <ChainFilterChips counts={stateCounts} total={chains.length} active={chainFilter} onPick={setChainFilter} />
                {/* Issue #647：高扇入排除清单可见不黑箱（合并后修复密度信号的边界一）*/}
                <FanInExcludedList files={fanInExcluded} />
              </div>
              <ChainsPanel
                chains={chainFilter ? chains.filter(c => c.state === chainFilter) : chains}
                onOpen={setActiveChainId}
              />
            </div>
          )}
          {/* 用量/效率视图（F20260914usgm：模型主维度改版，成本展示撤除） */}
          {tab === 'cost' && (
            <div className="space-y-4">
              {costOutput && costOutput.series.length > 0 ? (
                <>
                  {/* 汇总指标卡 */}
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                    <MetricCard label="总 Token" value={fmtLargeNumber(costOutput.totals.totalTokens)} icon={<BarChart3 className="w-4 h-4" />} />
                    <MetricCard label="LLM 调用" value={costOutput.totals.callCount} icon={<RefreshCw className="w-4 h-4" />} />
                    <MetricCard label="失败调用" value={costOutput.totals.errorCalls} icon={<AlertTriangle className="w-4 h-4 text-amber-500" />} />
                    <MetricCard label="獭发言数" value={costOutput.totals.messageCount} icon={<GitBranch className="w-4 h-4" />} />
                    <MetricCard label="每日派工" value={costOutput.totals.dispatchCount} icon={<Layers className="w-4 h-4" />} />
                  </div>

                  {/* 两个占比图：Token 占比 + 调用次数占比（F20260914usgm 搭档需求②） */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <ChartCard title="Token 占比 · 按模型" subtitle="区间累计 totalTokens" icon={<PieIcon className="w-4 h-4 text-otter-500" />}>
                      <ModelUsagePie models={costOutput.models} metric="totalTokens" />
                    </ChartCard>
                    <ChartCard title="调用次数占比 · 按模型" subtitle="区间累计 llm_call_count" icon={<PieIcon className="w-4 h-4 text-otter-500" />}>
                      <ModelUsagePie models={costOutput.models} metric="callCount" />
                    </ChartCard>
                  </div>

                  {/* 模型明细表：token 四分类/调用/失败/命中率（F20260914usgm 搭档需求①） */}
                  <ChartCard title="模型用量明细" subtitle={`按 totalTokens 降序 · 失败调用含 403/500 等 LLM 错误`} icon={<Layers className="w-4 h-4 text-otter-500" />}>
                    <ModelUsageTable models={costOutput.models} />
                  </ChartCard>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Token 趋势 */}
                    <ChartCard title="Token 消耗趋势" subtitle="日 token 合计（input + output + cache）" icon={<BarChart3 className="w-4 h-4 text-otter-500" />}>
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

                    {/* 缓存命中率 + 失败调用趋势（双轴） */}
                    <ChartCard title="缓存命中率 / 失败调用" subtitle="加权平均 hitRate · 日失败调用数" icon={<Activity className="w-4 h-4 text-otter-500" />}>
                      <ResponsiveContainer width="100%" height={220}>
                        <ComposedChart data={costOutput.series.map(p => ({ ...p, cacheHitRatePct: Number((p.cacheHitRate * 100).toFixed(2)) }))} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
                          <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fontSize: 11, fill: '#78716c' }} />
                          <YAxis yAxisId="left" domain={[0, 100]} unit="%" tick={{ fontSize: 11, fill: '#78716c' }} />
                          <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: '#78716c' }} />
                          <Tooltip labelFormatter={l => `快照 ${fmtDate(String(l))}`} />
                          <Line yAxisId="left" type="monotone" dataKey="cacheHitRatePct" name="命中率%" stroke={CARAMEL[500]} strokeWidth={2} dot={false} />
                          <Bar yAxisId="right" dataKey="errorCalls" name="失败调用" fill="#f87171" radius={[3, 3, 0, 0]} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </ChartCard>
                  </div>

                  {/* 单次问答均值：总 + 按模型（F20260914usgm 搭档需求③） */}
                  <ChartCard title="单次 invoke 均值" subtitle={`最新快照 ${costOutput.latestSnapshotDate ?? '—'} · token 为 session 累计差分口径`} icon={<Activity className="w-4 h-4 text-otter-500" />}>
                    <InvokeStatsTable stats={costOutput.invokeStats} />
                  </ChartCard>

                  {/* Per-otter 明细（保留低优先展示，默认折叠） */}
                  {costOutput.otters.length > 0 && (
                    <details className="rounded-2xl bg-white/70 border border-stone-200/60">
                      <summary className="px-4 py-3 text-sm font-semibold text-stone-600 cursor-pointer select-none">
                        獭明细（辅助视图，{costOutput.otters.length} 只 · 按模型主维度设计的补充）
                      </summary>
                      <div className="divide-y divide-stone-100 px-4">
                        {costOutput.otters.map(otter => (
                          <div key={otter.otterId} className="py-2.5">
                            <div className="flex items-center gap-3 text-sm">
                              <span className="font-medium text-stone-700 min-w-[120px]">{otter.otterName}</span>
                              <span className="px-2 py-0.5 rounded-full text-xs bg-skeleton text-stone-500">{otter.otterType}</span>
                              <span className="text-stone-500 text-xs ml-auto">
                                {fmtLargeNumber(otter.totalTokens)} tok · {otter.callCount} 次
                              </span>
                              <span className="text-xs text-amber-600">命中 {(otter.cacheHitRate * 100).toFixed(1)}%</span>
                              <span className="text-xs text-stone-400">发言 {otter.messageCount}</span>
                            </div>
                            {otter.models.length > 1 && (
                              <div className="flex flex-wrap gap-2 mt-1 ml-2">
                                {otter.models.map(m => (
                                  <span key={m.model} className="text-xs text-stone-400">
                                    {m.model}: {fmtLargeNumber(m.totalTokens)} tok
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </>
              ) : (
                <div className="rounded-2xl bg-white/70 border border-stone-200/60 py-16 text-center">
                  <BarChart3 className="w-10 h-10 mx-auto mb-3 text-stone-300" />
                  <p className="text-sm text-stone-500">还没有用量数据——点右上角「立即扫描」生成第一份</p>
                  <p className="text-xs text-stone-400 mt-1">扫描会解析 session JSONL 和 invokes 表，写入 cost_output 快照</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {/* 链详情抽屉（Issue #649 交付 3）：点泳道行展开，全量 commits + 状态归因 */}
      <ChainDetailDrawer featureId={activeChainId} onClose={() => setActiveChainId(null)} />
    </>
  )
}

// ── 图表数据变换 ──

function fmtDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(5) : iso
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

/** 大数字格式化：1234567 → 1.23M */
function fmtLargeNumber(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return String(v)
}

/** F20260914usgm：模型占比环形图（token 占比 / 调用次数占比，metric 切换） */
function ModelUsagePie({ models, metric }: { models: api.RhiModelUsageDTO[]; metric: 'totalTokens' | 'callCount' }) {
  const data = models.map(m => ({ name: m.model, value: m[metric] })).filter(d => d.value > 0)
  const total = data.reduce((s, d) => s + d.value, 0)
  if (total === 0) return <EmptyChart text="无数据" />
  return (
    <div>
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={55} outerRadius={80} paddingAngle={2}>
            {data.map((_, i) => (
              <Cell key={i} fill={COST_OUTPUT_COLORS[i % COST_OUTPUT_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(v: number, name: string) => [`${fmtLargeNumber(v)}（${((v / total) * 100).toFixed(1)}%）`, name]} />
          <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}

/** F20260914usgm：模型用量明细表（token 四分类/调用/失败/命中率） */
function ModelUsageTable({ models }: { models: api.RhiModelUsageDTO[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-stone-400 border-b border-stone-200">
            <th className="py-2 pr-4 font-medium">模型</th>
            <th className="py-2 pr-4 font-medium text-right">输入</th>
            <th className="py-2 pr-4 font-medium text-right">输出</th>
            <th className="py-2 pr-4 font-medium text-right">缓存读</th>
            <th className="py-2 pr-4 font-medium text-right">缓存写</th>
            <th className="py-2 pr-4 font-medium text-right">总计</th>
            <th className="py-2 pr-4 font-medium text-right">调用</th>
            <th className="py-2 pr-4 font-medium text-right">失败</th>
            <th className="py-2 pr-4 font-medium text-right">命中率</th>
          </tr>
        </thead>
        <tbody>
          {models.map(m => (
            <tr key={m.model} className="border-b border-stone-100">
              <td className="py-2 pr-4 font-medium text-stone-700">{m.model}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-stone-500">{fmtLargeNumber(m.inputTokens)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-stone-500">{fmtLargeNumber(m.outputTokens)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-stone-500">{fmtLargeNumber(m.cacheReadTokens)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-stone-500">{fmtLargeNumber(m.cacheWriteTokens)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-stone-600 font-medium">{fmtLargeNumber(m.totalTokens)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-stone-500">{m.callCount}</td>
              <td className={`py-2 pr-4 text-right tabular-nums ${m.errorCalls > 0 ? 'text-amber-600 font-medium' : 'text-stone-400'}`}>{m.errorCalls}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-stone-500">{(m.cacheHitRate * 100).toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** F20260914usgm：单次 invoke 均值表（_total 置顶 + per-model） */
function InvokeStatsTable({ stats }: { stats: api.RhiInvokeStatsDTO[] }) {
  const sorted = [...stats].sort((a, b) => (a.model === '_total' ? -1 : b.model === '_total' ? 1 : b.invokeCount - a.invokeCount))
  if (sorted.length === 0) return <EmptyChart text="无 invoke 数据（需有 model 归属的新 invoke）" />
  const fmtDuration = (sec: number) => (sec >= 90 ? `${(sec / 60).toFixed(1)}m` : `${Math.round(sec)}s`)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-stone-400 border-b border-stone-200">
            <th className="py-2 pr-4 font-medium">模型</th>
            <th className="py-2 pr-4 font-medium text-right">invoke 数</th>
            <th className="py-2 pr-4 font-medium text-right">平均工具调用</th>
            <th className="py-2 pr-4 font-medium text-right">平均耗时</th>
            <th className="py-2 pr-4 font-medium text-right">平均输入 tok</th>
            <th className="py-2 pr-4 font-medium text-right">平均输出 tok</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(s => (
            <tr key={s.model} className={`border-b border-stone-100 ${s.model === '_total' ? 'bg-stone-50/60' : ''}`}>
              <td className="py-2 pr-4 font-medium text-stone-700">{s.model === '_total' ? '全部模型' : s.model}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-stone-500">{s.invokeCount}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-stone-500">{s.avgToolCalls}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-stone-500">{fmtDuration(s.avgDurationSec)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-stone-500">{fmtLargeNumber(s.avgInputTokens)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-stone-500">{fmtLargeNumber(s.avgOutputTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
