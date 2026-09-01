/**
 * Issue #647 PR2：健康面板总览+信号重设计组件集。
 *
 * 设计依据（chen 已确认方向）：
 * - 视觉方案：ui-redesign-visual-review.md（观澜）——复发卡/低置信抽屉/热力条/sparkline/色彩纪律
 * - 信息架构：ui-redesign-info-arch.md（大獭补完）——总览重组为「出血点仪表」
 *
 * 色彩纪律（视觉方案 3.4，token 不自造色值）：
 * - teal-500 = 健康/活跃/fix commit；caramel-400~600 = 注意/停滞/bug commit/热力；
 * - rose（红）只允许出现在「需要行动」元素（复发徽章、critical 计数）；
 * - 图表库默认蓝绿橙全面退场，系列色用 teal/otter/lavender 阶梯度。
 */

import { useState } from 'react'
import { ChevronDown, ShieldCheck, Flame, GitCommit } from 'lucide-react'
import type { RhiSignalDTO } from '../../api/client'

// ── 色彩 token（单一定义点，跨组件复用；语义锁定见文件头注释）──

/** 变更类型节点色：BugFix=teal（修复=正向），其余=caramel（引入/变更=注意） */
export function changeTypeNodeColor(changeType: string | null): string {
  return changeType === 'BugFix' ? '#3A8B8B' : '#C9956B'
}

/** 变更类型中文短标签（时间轴节点下方） */
export function changeTypeShortLabel(changeType: string | null): string {
  if (changeType === 'BugFix') return 'fix'
  if (changeType === 'New Feature') return 'new'
  if (changeType === 'Feature Update') return 'upd'
  if (changeType === 'Refactor') return 'ref'
  return changeType ?? '?'
}

/** 热力映射：频次归一到 teal（低）→ caramel（高）区间（视觉方案 3.3） */
export function heatColor(ratio: number): string {
  // teal-500 #3A8B8B → caramel-500 #C9956B 线性插值（ratio ∈ [0,1]）
  const t = Math.max(0, Math.min(1, ratio))
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t)
  const r = mix(0x3a, 0xc9), g = mix(0x8b, 0x95), b = mix(0x8b, 0x6b)
  return `#${[r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')}`
}

/** 复发信号（critical bug_recurrence + post_merge_fix_density warning）判定 */
export function isRecurrenceSignal(s: RhiSignalDTO): boolean {
  return s.signal_type === 'bug_recurrence' || s.signal_type === 'post_merge_fix_density'
}

/** 复发卡排序键：频次 × 最近复发时间（最热最上，视觉方案 3.1） */
export function recurrenceSortKey(s: RhiSignalDTO): number {
  const commits = evidenceCommits(s)
  const lastMs = commits.length > 0 ? new Date(commits[commits.length - 1]!.date).getTime() : new Date(s.last_seen).getTime()
  const daysAgo = Math.max(0, (Date.now() - lastMs) / 86400000)
  return commits.length * 1000 - daysAgo * 10
}

/** 结构化证据的 commit 序列归一：bug_recurrence 用 commits，密度信号用 fixCommits */
function evidenceCommits(s: RhiSignalDTO): Array<{ sha: string; date: string; changeType: string | null; message: string }> {
  const d = s.evidenceDetail
  return d?.commits ?? d?.fixCommits ?? []
}

// ── 复发模式卡（首屏主角，视觉方案 3.1）──

/** 复发频次徽章值：从 evidenceDetail commit 序列派生——禁用 occurrences（扫描触发次数，随扫描频率漂移） */
function recurrenceBadgeCount(s: RhiSignalDTO): number {
  const commits = evidenceCommits(s)
  if (commits.length > 0) return commits.filter(c => c.changeType === 'BugFix').length
  // evidenceDetail 缺失（旧数据/null 降级）：退回 occurrences 展示（兼容，不崩）
  return s.occurrences
}

/** 证据链时间轴数据：节点按日期映射到 0-100% 位置 */
export function timelineNodes(s: RhiSignalDTO): Array<{ pct: number; sha: string; date: string; changeType: string | null; message: string }> {
  const commits = evidenceCommits(s)
  if (commits.length === 0) return []
  const times = commits.map(c => new Date(c.date).getTime())
  const min = Math.min(...times)
  const max = Math.max(...times)
  const span = Math.max(max - min, 1)
  return commits.map((c, i) => ({
    pct: times.length === 1 ? 50 : ((times[i]! - min) / span) * 100,
    sha: c.sha,
    date: c.date.slice(0, 10),
    changeType: c.changeType,
    message: c.message,
  }))
}

export function RecurrenceCard({ signal }: { signal: RhiSignalDTO }) {
  const nodes = timelineNodes(signal)
  const badge = recurrenceBadgeCount(signal)
  const windowDays = signal.evidenceDetail?.windowDays
  const isDensity = signal.signal_type === 'post_merge_fix_density'
  const detail = signal.evidenceDetail

  return (
    <div className="rounded-2xl bg-white/80 border border-stone-200/70 px-4 py-3">
      {/* 卡头：文件路径（等宽）+ 频次徽章（caramel-600 实心）+ 定性标签 */}
      <div className="flex items-center gap-2 flex-wrap">
        <GitCommit className="w-3.5 h-3.5 text-otter-400 shrink-0" />
        <span className="font-mono text-xs text-otter-800 truncate flex-1 min-w-0">
          {signal.file_path ?? signal.feature_id ?? '—'}
        </span>
        <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-caramel-600 text-white shrink-0">
          {badge} 次{windowDays ? ` / ${windowDays}天` : ''}
        </span>
        <span className="px-2 py-0.5 rounded-full text-xs border border-lavender-400 text-lavender-500 shrink-0">
          {isDensity ? '合并后修复密度' : '设计问题嫌疑'}
        </span>
      </div>

      {/* 卡身：bug●→fix● 时间轴（交替节奏画出来而非列出来） */}
      {nodes.length > 0 ? (
        <div className="mt-3 mb-1">
          <div className="relative h-8">
            <div className="absolute left-0 right-0 top-2 h-0.5 bg-otter-200 rounded-full" />
            {nodes.map((n, i) => (
              <div
                key={`${n.sha}-${i}`}
                className="absolute -translate-x-1/2 group"
                style={{ left: `${Math.max(3, Math.min(97, n.pct))}%` }}
                title={`${n.date} ${n.changeType ?? ''} ${n.sha}: ${n.message}`}
              >
                <span
                  className="block w-2.5 h-2.5 rounded-full ring-2 ring-white"
                  style={{ backgroundColor: changeTypeNodeColor(n.changeType) }}
                />
                <span className="block mt-0.5 text-[9px] text-stone-400 font-mono text-center -translate-x-1/2 relative left-1/2 whitespace-nowrap">
                  {changeTypeShortLabel(n.changeType)}
                </span>
              </div>
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-stone-400 font-mono">
            <span>{nodes[0]!.date}</span>
            <span>{nodes[nodes.length - 1]!.date}</span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-stone-500 mt-2">{signal.evidence}</p>
      )}

      {/* 修复密度专属：占比 + 排除清单（不黑箱，Issue #647 验收项） */}
      {isDensity && detail?.fixRatio !== undefined && (
        <p className="text-[11px] text-stone-500 mt-1.5">
          占比 {(detail.fixRatio * 100).toFixed(0)}%（相关 {detail.totalRelatedCommits ?? '—'} commit）
          {Array.isArray(detail.excludedHighFaninFiles) && detail.excludedHighFaninFiles.length > 0
            ? ` · 已排除高扇入文件 ${detail.excludedHighFaninFiles.length} 个（文件级出血由 bug 复发信号兑底）`
            : ''}
        </p>
      )}

      {signal.suggested_action && (
        <p className="text-[11px] text-otter-500 mt-1">建议：{signal.suggested_action}</p>
      )}
    </div>
  )
}

// ── 复发模式区（首屏主角容器：Top N + 空态确定感）──

export function RecurrencePanel({ signals }: { signals: RhiSignalDTO[] }) {
  const recurrence = signals.filter(isRecurrenceSignal).sort((a, b) => recurrenceSortKey(b) - recurrenceSortKey(a))
  if (recurrence.length === 0) {
    return (
      <div className="rounded-2xl bg-white/80 border border-stone-200/70 px-4 py-6 text-center">
        <ShieldCheck className="w-6 h-6 mx-auto mb-1.5 text-teal-500" />
        <p className="text-sm text-stone-600">近窗口无复发模式</p>
        <p className="text-xs text-stone-400 mt-0.5">没有文件/特性在反复出血，健康确定感 +1</p>
      </div>
    )
  }
  return (
    <div className="space-y-2.5">
      {recurrence.slice(0, 5).map(s => <RecurrenceCard key={s.id} signal={s} />)}
      {recurrence.length > 5 && (
        <p className="text-xs text-stone-400 text-center">其余 {recurrence.length - 5} 个复发模式在「信号」视图查看全部</p>
      )}
    </div>
  )
}

// ── 低置信折叠抽屉（噪音隔离，视觉方案 3.1）──

export function LowConfidenceDrawer({ signals }: { signals: RhiSignalDTO[] }) {
  const [open, setOpen] = useState(false)
  const low = signals.filter(s => s.confidence === 'low')
  if (low.length === 0) return null
  return (
    <div className="rounded-2xl bg-otter-100/60 border border-otter-200/50">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-4 py-2 text-sm text-otter-600 hover:bg-otter-100/80 transition-colors rounded-2xl"
      >
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-0' : '-rotate-90'}`} />
        <span>低置信信号（大概率误报，待核实）</span>
        <span className="ml-auto px-2 py-0.5 rounded-full text-xs bg-otter-200/70 text-otter-700">{low.length}</span>
      </button>
      {open && (
        <div className="px-4 pb-3 space-y-2">
          {low.map(s => (
            <div key={s.id} className="rounded-xl bg-white/70 px-3 py-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-otter-700">{s.signalTypeLabel}</span>
                {/* 低置信信号徽章降一级：描边样式而非实心（不透支警示色信用） */}
                <span className="px-1.5 py-0.5 rounded text-[10px] border border-caramel-400 text-caramel-600">{s.severity}</span>
                {s.feature_id && <span className="font-mono text-[10px] text-stone-400">{s.feature_id}</span>}
              </div>
              <p className="text-[11px] text-stone-500 mt-0.5">{s.evidence}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── 热点热力条（30 天修改频次 teal→caramel，视觉方案 3.3）──

export function HotspotHeatBar({ files, maxCount }: {
  files: Array<{ file: string; count: number }>
  maxCount?: number
}) {
  if (files.length === 0) {
    return <div className="text-xs text-stone-400 py-3 text-center">无热点文件数据</div>
  }
  const top = files.slice(0, 8)
  const max = maxCount ?? Math.max(...top.map(f => f.count))
  return (
    <div className="space-y-1.5">
      {top.map(f => (
        <div key={f.file} className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-otter-800 truncate w-[46%]" title={f.file}>{f.file}</span>
          <div className="flex-1 h-3.5 rounded-full bg-otter-100 overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${Math.max(4, (f.count / max) * 100)}%`, backgroundColor: heatColor(f.count / max) }}
            />
          </div>
          <span className="text-[11px] text-stone-500 tabular-nums w-8 text-right">{f.count}</span>
        </div>
      ))}
    </div>
  )
}

// ── 趋势 sparkline（降级为一行高度，视觉方案 3.3）──

export function TrendSparkline({ series }: {
  series: Array<{ date: string; bugfix_ratio?: number; total_commits?: number }>
}) {
  const points = series.filter(p => p.bugfix_ratio !== undefined)
  if (points.length === 0) {
    return <div className="text-xs text-stone-400 py-2 text-center">无趋势数据</div>
  }
  const values = points.map(p => p.bugfix_ratio! * 100)
  const min = Math.min(...values), max = Math.max(...values)
  const span = Math.max(max - min, 1)
  const w = 100, h = 24
  const path = values.map((v, i) => {
    const x = values.length === 1 ? w / 2 : (i / (values.length - 1)) * w
    const y = h - 3 - ((v - min) / span) * (h - 6)
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const last = values[values.length - 1]!
  const total30 = points.reduce((s, p) => s + (p.total_commits ?? 0), 0)
  return (
    <div className="flex items-center gap-3 px-1">
      <svg viewBox={`0 0 ${w} ${h}`} className="flex-1 h-6" preserveAspectRatio="none" aria-label="BugFix 比率趋势">
        <path d={path} fill="none" stroke="#8B6F47" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="text-xs text-stone-500 shrink-0">
        BugFix <span className="font-semibold text-otter-700 tabular-nums">{last.toFixed(1)}%</span>
        <span className="text-stone-400 ml-2">近 {points.length} 天 {total30} commits</span>
      </span>
    </div>
  )
}

// ── 信号态势卡（数字卡改造：构成分列，视觉方案 3.1）──

export function SignalPostureCard({ overview, signals }: {
  overview: { openSignalsBySeverity: { critical: number; warning: number }; openSignalsByConfidence?: { normal: number; low: number } } | null
  signals: RhiSignalDTO[]
}) {
  const critical = overview?.openSignalsBySeverity.critical ?? 0
  const warning = overview?.openSignalsBySeverity.warning ?? 0
  const low = overview?.openSignalsByConfidence?.low ?? signals.filter(s => s.confidence === 'low').length
  const recurrence = signals.filter(isRecurrenceSignal).length
  return (
    <div className="rounded-2xl bg-white/80 border border-stone-200/70 px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-stone-500 mb-2">
        <Flame className="w-3.5 h-3.5 text-otter-400" />
        <span className="font-semibold text-stone-600">信号态势</span>
        <span className="text-stone-400">· 高置信/低置信分列（低置信不计主数 #652）</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className={`text-2xl font-bold tabular-nums ${critical > 0 ? 'text-rose-600' : 'text-stone-700'}`}>{critical}</div>
          <div className="text-[11px] text-stone-400">critical（高置信）</div>
        </div>
        <div>
          <div className={`text-2xl font-bold tabular-nums ${warning > 0 ? 'text-amber-600' : 'text-stone-700'}`}>{warning}</div>
          <div className="text-[11px] text-stone-400">warning（高置信）</div>
        </div>
        <div>
          <div className="text-2xl font-bold tabular-nums text-otter-500">{low}</div>
          <div className="text-[11px] text-stone-400">低置信待核实</div>
        </div>
      </div>
      {recurrence > 0 && (
        <p className="text-[11px] text-stone-400 mt-1.5 text-center">复发模式 {recurrence} 个——下方按热度排列</p>
      )}
    </div>
  )
}
