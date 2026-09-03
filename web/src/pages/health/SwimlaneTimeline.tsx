/**
 * 链泳道时间线（Issue #649，健康面板 PR3）——视觉方案 ui-redesign-visual-review.md §3.2。
 *
 * 形态：每链一条泳道，节点圆点按日期线性映射到共享 x 轴（默认 60 天窗口，与
 * 链构建窗口 30+30 对齐）；窗口外老链起点贴左缘截断标注（data-clipped-start）。
 * 四态线尾表达（§3.2 色义锁定；F20260902sigm：zombie 删除，stalled=pr-stalled）：
 * - active：teal 实线 + 末端呼吸动画（全场唯一动效，swim-active-pulse + SMIL）
 * - stalled（pr-stalled）：线尾虚化（dashed fade-out）+ caramel 空心圆末端 + 「PR 停滞 N 天」旁注
 * - regressed：线体 teal + 线中段 caramel-700 回卷标记（swim-regressed-mark）
 * - orphan：lavender 悬空空心起点（swim-orphan-start）
 * 密度原则（§3.5）：动效仅 active 呼吸一处；异常用实心饱和、常态低饱和；
 * 虚拟化：手写窗口化（滚动容器 + 可视区间渲染，行高 38px），零新依赖。
 * 节点色：bug 系 commit=caramel、其他=teal（复发卡同款色义，#649 拍板）。
 */

import { useState, useMemo, useCallback } from 'react'
import { FileCode } from 'lucide-react'
import type { RhiChainDTO } from '../../api/client'
import { TEAL, CARAMEL, OTTER, LAVENDER } from './palette'
import { CHAIN_STATE_META, chainStateRank, commitNodeColor, ANOMALY_STATES, type ChainState } from './chain-state-meta'

// ── 布局常量 ──
const ROW_H = 38
const ROW_W = 860
const LABEL_W = 170
const LANE_X0 = LABEL_W + 12
const LANE_X1 = ROW_W - 16
const VIEWPORT_H = 480
const OVERSCAN = 4
const WINDOW_DAYS = 60
const DAY_MS = 24 * 60 * 60 * 1000
/** 共享 x 轴线性映射：[now-60d, now] → [LANE_X0, LANE_X1]；窗口外截断到左缘 */
function makeTimeScale(now: Date): (iso: string | null) => number {
  const end = now.getTime()
  const start = end - WINDOW_DAYS * DAY_MS
  return iso => {
    if (!iso) return LANE_X0
    const t = new Date(iso).getTime()
    const ratio = Math.min(1, Math.max(0, (t - start) / (end - start)))
    return LANE_X0 + ratio * (LANE_X1 - LANE_X0)
  }
}

export function sortChainsBySeverity(chains: RhiChainDTO[]): RhiChainDTO[] {
  return chains.slice().sort((a, b) =>
    chainStateRank(b.state) - chainStateRank(a.state)
    || (b.daysSinceLastCommit ?? 0) - (a.daysSinceLastCommit ?? 0))
}

/** 单行泳道几何：节点位置 + 线段端点 + 截断标记 */
interface LaneGeom {
  nodes: Array<{ x: number; color: string; sha: string; date: string; changeType: string | null }>
  firstX: number
  lastX: number
  clippedStart: boolean
  regressedAtX: number | null
}

function buildLaneGeom(ch: RhiChainDTO, xOf: (iso: string | null) => number, now: Date): LaneGeom {
  const start = now.getTime() - WINDOW_DAYS * DAY_MS
  const nodes = ch.commits.map(cm => ({
    x: xOf(cm.date), color: commitNodeColor(cm.changeType),
    sha: cm.sha, date: cm.date, changeType: cm.changeType,
  }))
  const xs = nodes.map(n => n.x)
  const firstX = xs.length ? Math.min(...xs) : LANE_X0
  const lastX = xs.length ? Math.max(...xs) : LANE_X0
  const clippedStart = ch.commits.some(cm => new Date(cm.date).getTime() < start)
  // 回卷标记：链上最新一个 BugFix 节点位置（从尾部找）
  let regressedAtX: number | null = null
  for (let i = ch.commits.length - 1; i >= 0; i--) {
    if (ch.commits[i]!.changeType === 'BugFix') { regressedAtX = nodes[i]!.x; break }
  }
  return { nodes, firstX, lastX, clippedStart, regressedAtX }
}

/** 四态线体色（§3.2 + §3.4：stalled 线体 caramel-400 浅阶；regressed 线体 teal——
 *  它本质仍是进行中的链，caramel-700 只给回卷标记） */
function laneLineColor(state: ChainState): string {
  if (state === 'stalled') return CARAMEL[400]
  if (state === 'orphan') return LAVENDER[400]
  return TEAL[500]
}

/** 20 字符截断（SVG text 无 CSS ellipsis） */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** 单行泳道：行背景 + 链名 + 线体 + 节点 + 线尾表达（视觉契约 class 全在此） */
function SwimRow({ ch, y, xOf, now, onOpen }: { ch: RhiChainDTO; y: number; xOf: (iso: string | null) => number; now: Date; onOpen: (id: string) => void }) {
  const geo = buildLaneGeom(ch, xOf, now)
  const lineColor = laneLineColor(ch.state)
  const hasCommits = geo.nodes.length > 0
  const label = ch.docTitle ?? '无文档'
  return (
    <g
      className="swim-row"
      data-state={ch.state}
      data-feature-id={ch.featureId}
      data-clipped-start={geo.clippedStart ? '1' : undefined}
      transform={`translate(0 ${y})`}
      style={{ cursor: 'pointer' }}
      onClick={() => onOpen(ch.featureId)}
    >
      <rect x={0} y={1} width={ROW_W} height={ROW_H - 2} fill="transparent" />
      <title>{`${CHAIN_STATE_META[ch.state]?.label ?? ch.state} · ${ch.featureId} · ${ch.commitCount} commits${ch.daysSinceLastCommit !== null ? ` · 距上次 ${ch.daysSinceLastCommit} 天` : ''}`}</title>
      {/* 左缘截断标注：窗口外老链，起点贴左缘（§3.2 共享 x 轴约定） */}
      {geo.clippedStart && (
        <g className="swim-clipped-mark">
          <line x1={LANE_X0 - 6} y1={ROW_H / 2 - 6} x2={LANE_X0 - 6} y2={ROW_H / 2 + 6} stroke={OTTER[400]} strokeWidth={2} />
          <title>此链早于 60 天窗口，起点截断显示</title>
        </g>
      )}
      <text x={0} y={ROW_H / 2 - 2} fontSize={11} fill="#57534e">{truncate(label, 14)}</text>
      <text x={0} y={ROW_H / 2 + 11} fontSize={9} fill="#a8a29e" fontFamily="monospace">{truncate(ch.featureId, 15)}</text>
      {/* 线体（有 ≥2 节点才画；orphan 无 commit 时悬空起点圆在下方独立表达） */}
      {hasCommits && (
        <line
          className={`swim-lane-line swim-${ch.state}`}
          x1={geo.firstX} y1={ROW_H / 2} x2={geo.lastX} y2={ROW_H / 2}
          stroke={lineColor} strokeWidth={2}
        />
      )}
      {/* orphan：悬空空心起点（无入边连接，§3.2 lavender-400） */}
      {ch.state === 'orphan' && (
        <circle className="swim-orphan-start" data-orphan-start="1" cx={hasCommits ? geo.firstX : LANE_X0 + 6} cy={ROW_H / 2} r={4.5} fill="none" stroke={LAVENDER[400]} strokeWidth={2} />
      )}
      {/* commit 节点：实心圆，bug 系=caramel、其他=teal */}
      {geo.nodes.map((n, i) => (
        <circle key={i} className="swim-commit-node" cx={n.x} cy={ROW_H / 2} r={3.5} fill={n.color} stroke="#ffffff" strokeWidth={1}>
          <title>{`${n.sha} · ${n.date.slice(0, 10)} · ${n.changeType ?? '—'}`}</title>
        </circle>
      ))}
      {/* 状态线尾表达 */}
      {ch.state === 'active' && hasCommits && (
        <g className="swim-active-end">
          <circle className="swim-active-pulse" cx={geo.lastX} cy={ROW_H / 2} r={5} fill={TEAL[500]}>
            <animate attributeName="r" values="4;7;4" dur="3s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.5;0.15;0.5" dur="3s" repeatCount="indefinite" />
          </circle>
        </g>
      )}
      {ch.state === 'stalled' && hasCommits && (
        <StalledTail lastX={geo.lastX} label={stalledPrLabel(ch)} />
      )}
      {ch.state === 'regressed' && geo.regressedAtX !== null && (
        <path
          className="swim-regressed-mark"
          d={`M ${geo.regressedAtX + 7} ${ROW_H / 2 - 6} A 8 8 0 1 0 ${geo.regressedAtX + 9} ${ROW_H / 2 + 5}`}
          stroke={CARAMEL[700]} strokeWidth={2.2} fill="none" strokeLinecap="round"
        />
      )}
    </g>
  )
}

/** pr-stalled 旁注文案：单 PR 「#N 停 7 天」，多 PR 「#N 等 2 个」 */
function stalledPrLabel(ch: RhiChainDTO): string {
  const sig = ch.signals.find(s => s.id === 'pr-stalled')
  const prs = sig?.stalledPrs ?? []
  if (prs.length === 0) return 'PR 停滞'
  const first = prs[0]!
  if (prs.length === 1) return `#${first.number} 停 ${first.daysSinceActivity} 天`
  return `#${first.number} 等 ${prs.length} 个`
}

/** stalled（pr-stalled）线尾：虚化尾巴（dashed fade-out）+ caramel 空心圆 + 「PR 停滞」旁注 */
function StalledTail({ lastX, label }: { lastX: number; label?: string }) {
  const tailLen = 34
  const endX = lastX + tailLen
  const labelRight = endX + 78 > LANE_X1 // 右边界放不下旁注则翻到空心圆左侧
  return (
    <g className="swim-stalled-tail">
      <line
        className="swim-stalled-fade"
        x1={lastX} y1={ROW_H / 2} x2={endX} y2={ROW_H / 2}
        stroke={CARAMEL[500]} strokeWidth={2} strokeDasharray="5 4" opacity={0.75}
      />
      <circle className="swim-stalled-end" cx={endX} cy={ROW_H / 2} r={4.5} fill="none" stroke={CARAMEL[500]} strokeWidth={2} />
      <text
        className="swim-stalled-label"
        x={labelRight ? lastX - 6 : endX + 8}
        y={ROW_H / 2 + 4}
        fontSize={10}
        fill={CARAMEL[600]}
        textAnchor={labelRight ? 'end' : 'start'}
      >
        {label ?? 'PR 停滞'}
      </text>
    </g>
  )
}

/** 共享 x 轴：窗口刻度 7 档（每 10 天），MM/DD */
function XAxis({ now }: { now: Date }) {
  const end = now.getTime()
  const ticks = Array.from({ length: 7 }, (_, i) => {
    const t = end - (WINDOW_DAYS - i * 10) * DAY_MS
    return { x: LANE_X0 + (i * 10 / WINDOW_DAYS) * (LANE_X1 - LANE_X0), label: new Date(t).toISOString().slice(5, 10).replace('-', '/') }
  })
  return (
    <g className="swim-x-axis">
      <line x1={LANE_X0 - 8} y1={8} x2={LANE_X1 + 8} y2={8} stroke="#e7e5e4" strokeWidth={1} />
      {ticks.map(t => (
        <g key={t.label}>
          <line x1={t.x} y1={5} x2={t.x} y2={11} stroke="#d6d3d1" strokeWidth={1} />
          <text x={t.x} y={22} fontSize={10} fill="#a8a29e" textAnchor="middle">{t.label}</text>
        </g>
      ))}
    </g>
  )
}

/** 泳道时间线主体：手写窗口化（滚动容器 + 可视区间 ±OVERSCAN 渲染，零依赖） */
export function SwimlaneTimeline({ chains, onOpen }: { chains: RhiChainDTO[]; onOpen: (id: string) => void }) {
  const [scrollTop, setScrollTop] = useState(0)
  const now = useMemo(() => new Date(), [])
  const xOf = useMemo(() => makeTimeScale(now), [now])
  const total = chains.length
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const visibleCount = Math.ceil(VIEWPORT_H / ROW_H) + OVERSCAN * 2
  const end = Math.min(total, start + visibleCount)
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => setScrollTop(e.currentTarget.scrollTop), [])
  if (total === 0) {
    return (
      <div className="text-center py-12 text-stone-400" data-testid="swimlane-empty">
        <FileCode className="w-8 h-8 mx-auto mb-2 opacity-40" />
        无匹配链
      </div>
    )
  }
  return (
    <div className="overflow-auto" style={{ maxHeight: VIEWPORT_H + 36 }} data-testid="swimlane-scroll" onScroll={onScroll}>
      <div style={{ width: ROW_W }}>
        {/* 共享 x 轴 sticky 常驻：窗口化下泳道区可达 12k px 深，轴沉底等于不可见 */}
        <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'rgba(255,255,255,0.95)' }}>
          <svg width={ROW_W} height={28} style={{ display: 'block' }}>
            <XAxis now={now} />
          </svg>
        </div>
        <div style={{ height: total * ROW_H, position: 'relative' }}>
          <svg
            className="swimlane-svg"
            width={ROW_W}
            height={(end - start) * ROW_H}
            style={{ position: 'absolute', top: start * ROW_H, left: 0 }}
          >
            {chains.slice(start, end).map((ch, i) => (
              <SwimRow key={ch.featureId} ch={ch} y={i * ROW_H} xOf={xOf} now={now} onOpen={onOpen} />
            ))}
          </svg>
        </div>
      </div>
    </div>
  )
}

/** 异常态筛选 chips（Issue #649 交付 2，观澜 §3.2 视觉反转）：异常实心+计数徽章，
 *  活跃描边灰显；点异常 chip 泳道只留命中链（再点取消）。「全部」chip 恢复全量。
 *  放本模块而非 index.tsx：后者 import 时挂载 #root，组件测试无法引用。 */
export function ChainFilterChips({ counts, total, active, onPick }: {
  counts: Record<string, number>
  total: number
  active: ChainState | null
  onPick: (s: ChainState | null) => void
}) {
  const anomalyCount = ANOMALY_STATES.reduce((s, st) => s + (counts[st] ?? 0), 0)
  return (
    <div className="flex items-center gap-1.5 flex-wrap" data-testid="chain-filter-chips">
      <button
        className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
          active === null
            ? 'bg-stone-700 text-white border-stone-700'
            : 'bg-white text-stone-500 border-stone-200 hover:border-stone-300'
        }`}
        data-testid="chip-all"
        data-active={active === null ? '1' : undefined}
        onClick={() => onPick(null)}
      >
        全部 {total}
      </button>
      {ANOMALY_STATES.map(st => {
        const meta = CHAIN_STATE_META[st]
        const n = counts[st] ?? 0
        const isActive = active === st
        return (
          <button
            key={st}
            className="px-2.5 py-1 rounded-full text-xs font-medium border transition-colors"
            style={isActive
              ? { backgroundColor: meta.color, color: '#fff', borderColor: meta.color }
              : { backgroundColor: meta.color, color: '#fff', borderColor: meta.color, opacity: n === 0 ? 0.45 : 1 }}
            data-testid={`chip-${st}`}
            data-count={n}
            data-active={isActive ? '1' : undefined}
            onClick={() => onPick(isActive ? null : st)}
          >
            {meta.label} {n}
          </button>
        )
      })}
      {/* 活跃 chip：描边灰显（§3.2 视觉反转——常态在筛选语法里降级） */}
      <button
        className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
          active === 'active'
            ? 'bg-stone-200 text-stone-700 border-stone-300'
            : 'bg-white text-stone-400 border-stone-200'
        }`}
        data-testid="chip-active"
        data-count={counts['active'] ?? 0}
        data-active={active === 'active' ? '1' : undefined}
        onClick={() => onPick(active === 'active' ? null : 'active')}
      >
        活跃 {counts['active'] ?? 0}
      </button>
      <span className="text-[11px] text-stone-400 ml-1">
        异常 {anomalyCount} / {total}
      </span>
    </div>
  )
}
