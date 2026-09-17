/**
 * 总览页三层结构（issue #1029，低保真原型 health-panel-lofi.html 为设计真相源）。
 *
 * 第一层 判断：综合分大卡——归因句从卡片角落小字升级为主标题（三秒知道「好不好+为什么」）。
 * 第二层 维度：五维大白话改名 + 一句「这量在量什么」+ 分数条替雷达（一眼见高低），
 *        点击展开证据层——原料数据（提交类型环形图/热点清单/四态计数/合规数）收编进展开区。
 * 第三层 处置：红/黄维度各配一句建议动作，链到「警报」处置队列（triage 未接单数）。
 *
 * 色彩纪律沿用 palette token：teal=活跃/好、caramel=滞留/警示、stone 中性。
 */

import { useState, useEffect } from 'react'
import { ChevronDown, ChevronRight, AlertTriangle, ArrowRight, CheckCircle2 } from 'lucide-react'
import type { RhiScoreDTO, RhiTrendsDTO, RhiOverviewDTO } from '../../api/client'
import { SCORE_STATUS_CONFIG } from './score-status'
import { TrendIcon } from './TrendIcon'
import { CHANGE_TYPE_LABELS, CHAIN_STATE_PROGRESS, type ChainState } from './chain-state-meta'
import { hotspotData, HotspotHeatBar } from './HotspotHeat'
import { TEAL, CARAMEL, OTTER } from './palette'

export type DimensionId = 'D1' | 'D2' | 'D3' | 'D4' | 'D5'

/** 五维大白话名 + 「这量在量什么」（原型文案，搭档目验） */
export const DIMENSION_PLAIN: Record<DimensionId, { name: string; plain: string }> = {
  D1: { name: '修 bug 比例', plain: '写新功能 vs 擦屁股的占比' },
  D2: { name: '架构晃动', plain: '少数文件被反复改的次数' },
  D3: { name: '交付节奏', plain: '手上的事有多少在正常推进' },
  D4: { name: '流程纪律', plain: '提交按规范走的比例' },
  D5: { name: '告警处置', plain: '系统自检发现的问题有没有被处理' },
}

/** 健康线/归零线等口径锚点（与 health-score.ts 头注释一致，证据层文案引据） */
const D1_HEALTH_LINE = 0.2
const D1_ZERO_LINE = 0.4

function dimOf(score: RhiScoreDTO, id: DimensionId) {
  return score.dimensions.find(d => d.dimension === id)
}

// ── 第一层：判断卡 ──

/** 综合分大卡：大数字 + 归因句主标题（issue #1029：从角落小字升级为第一屏主标题） */
export function VerdictCard({ score }: { score: RhiScoreDTO | null }) {
  if (!score || !score.available || score.overall === null) {
    return (
      <div className="rounded-2xl bg-white/70 border border-stone-200/60 px-5 py-5 flex items-center gap-3">
        <AlertTriangle className="w-8 h-8 text-stone-300" />
        <div>
          <div className="text-sm font-semibold text-stone-600">综合健康分</div>
          <div className="text-xs text-stone-400 mt-0.5">扫描后生成（需连续 8 天数据出走向）</div>
        </div>
      </div>
    )
  }
  const cfg = SCORE_STATUS_CONFIG[score.overallStatus ?? 'yellow'] ?? SCORE_STATUS_CONFIG.yellow
  return (
    <div className={`rounded-2xl ${cfg.bg} border ${cfg.border} px-5 py-5 flex items-start gap-5`} data-testid="verdict-card">
      <div className="flex flex-col items-center shrink-0">
        <div className={`text-5xl font-bold tabular-nums leading-none ${cfg.text}`}>{Math.round(score.overall)}</div>
        <div className="text-[11px] text-stone-400 mt-1.5">综合健康分 · {cfg.label}</div>
        <div className="flex items-center gap-1 mt-1">
          <TrendIcon direction={score.trend.overall} />
          <span className="text-[11px] text-stone-400">走向</span>
        </div>
      </div>
      <div className="flex-1 min-w-0">
        {/* 归因句 = 主标题：扫一眼知道「好不好 + 为什么」 */}
        <p className="text-[15px] font-semibold text-stone-700 leading-snug" data-testid="verdict-attribution">
          {score.attribution ?? '五个方面都在健康线上，暂无拖累'}
        </p>
        <p className="text-xs text-stone-500 mt-1.5 leading-relaxed">
          快照 {score.snapshotDate ?? '—'} · 绿 ≥75 / 黄 50-74 / 红 &lt;50 · 点下面的红色维度看原因
        </p>
      </div>
    </div>
  )
}

// ── 第二层：五维行（点击展开证据层）──

/** 五维条形列表：每维大白话名 + 量什么 + 分数条，点开看证据（原料数据收编于此） */
export function DimensionRows({ score, trends, overview, untriagedCount }: {
  score: RhiScoreDTO | null
  trends: RhiTrendsDTO | null
  overview: RhiOverviewDTO | null
  /** 「警报」页未接单信号数（D5 证据 + 建议动作链路，F20260917trig triage 字段） */
  untriagedCount: number
}) {
  // 默认展开红/黄中最差的分（原型：「点红色的看原因」——不用自己找）。
  // 注意按分数而非状态取：状态只分三档（D2=40 与 D1=4 同红，但 D1 才是主拖累）。
  // score 是异步拉取的——首渲染为 null 时 initializer 会固化成 null（React 惰性初始化
  // 只跑一次），所以用 effect 在数据到位后设置一次初始值，不依赖 initializer 看到真数据
  const [openDim, setOpenDim] = useState<DimensionId | null>(null)
  useEffect(() => {
    if (openDim !== null || !score || !score.available) return
    const worst = score.dimensions
      .filter(d => d.score !== null && (d.status === 'red' || d.status === 'yellow'))
      .sort((a, b) => (a.score ?? 100) - (b.score ?? 100))[0]
    setOpenDim((worst?.dimension as DimensionId | undefined) ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score])
  if (!score || !score.available || score.dimensions.length === 0) {
    return (
      <div className="rounded-2xl bg-white/70 border border-stone-200/60 py-10 text-center text-sm text-stone-400">
        五维评分待扫描生成
      </div>
    )
  }
  return (
    <div className="space-y-2" data-testid="dimension-rows">
      <p className="text-xs font-semibold text-stone-500 tracking-wide">五个方面 · 点红色的看原因</p>
      {score.dimensions.map(d => {
        const id = d.dimension as DimensionId
        const plain = DIMENSION_PLAIN[id]
        const cfg = SCORE_STATUS_CONFIG[d.status ?? 'yellow'] ?? SCORE_STATUS_CONFIG.yellow
        const open = openDim === id
        const Chevron = open ? ChevronDown : ChevronRight
        return (
          <div
            key={id}
            className={`rounded-2xl bg-white/70 border px-4 py-3 cursor-pointer transition-colors ${
              open ? 'border-otter-400' : 'border-stone-200/60 hover:border-otter-300'
            }`}
            data-testid={`dim-row-${id}`}
            data-open={open ? '1' : undefined}
            data-status={d.status ?? 'none'}
            onClick={() => setOpenDim(open ? null : id)}
          >
            <div className="flex items-center gap-3">
              <Chevron className="w-3.5 h-3.5 text-stone-400 shrink-0" />
              <span className="text-sm font-semibold text-stone-700 min-w-[110px]">{plain.name}</span>
              <span className="text-[11px] text-stone-400 hidden sm:inline">{plain.plain}</span>
              <div className="flex-1 h-2 rounded-full bg-stone-100 overflow-hidden">
                {d.score !== null && (
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.max(d.score, 3)}%`,
                      backgroundColor: d.status === 'red' ? '#ef4444' : d.status === 'yellow' ? CARAMEL[500] : TEAL[500],
                    }}
                  />
                )}
              </div>
              <span className={`text-[15px] font-bold tabular-nums w-9 text-right ${cfg.text}`}>
                {d.score === null ? '—' : Math.round(d.score)}
              </span>
            </div>
            {/* 证据层：原料数据收编区（点开才看到——判断在上、证据在下钻） */}
            {open && (
              <div className="mt-3 pt-3 border-t border-dashed border-stone-200" data-testid={`dim-evidence-${id}`}>
                <DimensionEvidence dim={id} score={score} trends={trends} overview={overview} untriagedCount={untriagedCount} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** 证据层内容：每维的原料数据 + 一句「所以呢」（原型 evbox 文案） */
function DimensionEvidence({ dim, score, trends, overview, untriagedCount }: {
  dim: DimensionId
  score: RhiScoreDTO
  trends: RhiTrendsDTO | null
  overview: RhiOverviewDTO | null
  untriagedCount: number
}) {
  const d = dimOf(score, dim)
  if (!d) return null
  switch (dim) {
    case 'D1': {
      // 收编：提交类型环形图原料 + BugFix 比率卡 + 近 10 天 bugfix 占比走势
      const ratio = trends?.series?.slice(-10) ?? []
      const totalCommits = overview?.metrics.total_commits ?? 0
      const dist = trends?.distributions.change_types ?? {}
      const bugfixCount = dist.BugFix ?? 0
      const featureCount = (dist['New Feature'] ?? 0) + (dist['Feature Update'] ?? 0)
      return (
        <div className="space-y-2 text-xs text-stone-600 leading-relaxed" data-testid="evidence-d1">
          <p>
            健康线 ≤{Math.round(D1_HEALTH_LINE * 100)}%，{Math.round(D1_ZERO_LINE * 100)}% 以上归零——
            最近干的活里四成是在擦屁股而不是写新功能，就是这个分数的含义。
          </p>
          {totalCommits > 0 && (
            <p className="text-stone-500">
              近 60 天窗口共 {totalCommits} 个提交：修 bug {bugfixCount} 个、新功能 {featureCount} 个
              {bugfixCount > featureCount * 2 && '（修的量是新功能的两倍以上——典型救火模式）'}
            </p>
          )}
          {ratio.length > 1 && (
            <div>
              <BugfixRatioSparkline points={ratio} />
              <p className="text-[11px] text-stone-400 mt-1">↑ 近 {ratio.length} 天 bugfix 占比走势{ratio.every(p => (p.bugfix_ratio ?? 0) >= D1_HEALTH_LINE) ? '（一直在健康线上方，没降下来过）' : ''}</p>
            </div>
          )}
          <EvidenceAction to="signals">去「警报」看反复修 bug 的文件清单</EvidenceAction>
        </div>
      )
    }
    case 'D2': {
      // 收编：热点文件热力条（原平铺 ChartCard）
      const hotspots = hotspotData(trends)
      return (
        <div className="space-y-2 text-xs text-stone-600 leading-relaxed" data-testid="evidence-d2">
          <p>30 天内被改 15 次以上的文件算热区，每个扣 4 分，扣满 60 封顶。</p>
          {hotspots.length > 0 && (
            <div className="rounded-xl bg-stone-50/70 border border-stone-200/60 px-3 py-2">
              <HotspotHeatBar hotspots={hotspots} max={8} />
            </div>
          )}
          <p className="text-stone-500">这些是「谁都绕不开」的枢纽文件，频繁晃动说明改动不断波及全局——和修 bug 多互为因果。</p>
        </div>
      )
    }
    case 'D3': {
      // 收编：四态计数（链状态分布原料）
      const cs = trends?.distributions.chain_states ?? {}
      const entries = Object.entries(cs).filter(([, v]) => v > 0)
      const total = entries.reduce((s, [, v]) => s + v, 0)
      return (
        <div className="space-y-2 text-xs text-stone-600 leading-relaxed" data-testid="evidence-d3">
          <p>正常推进的链占比越高越好——卡住、回退、烂尾风险按权重扣分。</p>
          {total > 0 && (
            <p className="text-stone-500">
              {entries.map(([st, n]) => `${statePlainLabel(st)} ${n}`).join(' · ')}（共 {total} 件）
            </p>
          )}
          <EvidenceAction to="chains">去「进行中的事」看每条链的进度</EvidenceAction>
        </div>
      )
    }
    case 'D4': {
      const series = trends?.series ?? []
      const total = overview?.metrics.total_commits ?? 0
      const compliant = series.length > 0 ? series[series.length - 1]!.compliant_commits : undefined
      return (
        <div className="space-y-2 text-xs text-stone-600 leading-relaxed" data-testid="evidence-d4">
          <p>commit message 按规范格式的占比，线性计分。</p>
          {total > 0 && compliant !== undefined && (
            <p className="text-stone-500">{total} 个提交里 {compliant} 个符合规范格式。</p>
          )}
        </div>
      )
    }
    case 'D5': {
      const critical = overview?.openSignalsBySeverity.critical ?? 0
      const warning = overview?.openSignalsBySeverity.warning ?? 0
      return (
        <div className="space-y-2 text-xs text-stone-600 leading-relaxed" data-testid="evidence-d5">
          <p>未处置告警按手上的事归一——密度越低越好。</p>
          <p className="text-stone-500">
            当前未处置：critical {critical} / warning {warning}。逐条处置进度见「警报」页队列。
          </p>
          <EvidenceAction to="signals">
            {untriagedCount > 0 ? `去「警报」看 ${untriagedCount} 条未接单警报` : '去「警报」页看处置队列'}
          </EvidenceAction>
        </div>
      )
    }
  }
}

/** D1 证据层的 bugfix 占比迷你走势条（原型 spark：bad 段标红） */
function BugfixRatioSparkline({ points }: { points: Array<{ date: string; bugfix_ratio?: number }> }) {
  const vals = points.map(p => p.bugfix_ratio ?? 0)
  const max = Math.max(...vals, 0.01)
  return (
    <div className="flex items-end gap-1 h-7 mt-1" data-testid="bugfix-sparkline">
      {vals.map((v, i) => (
        <span
          key={i}
          className="w-2 rounded-t"
          style={{
            height: `${Math.max((v / max) * 100, 8)}%`,
            backgroundColor: v >= D1_HEALTH_LINE ? '#fca5a5' : OTTER[200],
          }}
          title={`${points[i]!.date.slice(5)} · ${(v * 100).toFixed(1)}%`}
        />
      ))}
    </div>
  )
}

function statePlainLabel(state: string): string {
  // 单一真相源：CHAIN_STATE_PROGRESS（chain-state-meta.ts）——检视 S2 修复，不再手写副本
  return CHAIN_STATE_PROGRESS[state as ChainState]?.label ?? state
}

/** 证据层底部动作链：跳到对应 tab（原型 action 胶囊） */
function EvidenceAction({ to, children }: { to: 'signals' | 'chains'; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs text-otter-600 border border-otter-300 hover:bg-otter-50 transition-colors"
      data-testid={`evidence-action-${to}`}
      onClick={e => {
        e.stopPropagation()
        window.location.hash = ''
        const url = new URL(window.location.href)
        url.searchParams.set('tab', to === 'signals' ? 'signals' : 'chains')
        window.location.href = url.toString()
      }}
    >
      {children}
      <ArrowRight className="w-3 h-3" />
    </button>
  )
}

// ── 第三层：建议动作 ──

/** 建议动作：红/黄维度各配一句「下一步去哪」（原型第三层；链到 triage 处置队列） */
export function ActionList({ score, untriagedCount }: {
  score: RhiScoreDTO | null
  untriagedCount: number
}) {
  if (!score || !score.available) return null
  const troubled = score.dimensions.filter(d => d.score !== null && (d.status === 'red' || d.status === 'yellow'))
  if (troubled.length === 0) {
    return (
      <div className="rounded-2xl bg-white/70 border border-stone-200/60 px-4 py-3 flex items-center gap-2" data-testid="action-list">
        <CheckCircle2 className="w-4 h-4 text-teal-600 shrink-0" />
        <p className="text-sm text-stone-600">五个方面都在健康线上，暂时不用动作——分数会自己告诉你什么时候变。</p>
      </div>
    )
  }
  const actions: Array<{ dim: DimensionId; text: string; to: 'signals' | 'chains' | null }> = []
  if (troubled.some(d => d.dimension === 'D1' || d.dimension === 'D2')) {
    actions.push({
      dim: 'D1', to: 'signals',
      text: '看「警报」页的复发清单——反复修的文件值得一次除根式重构，而不是继续打补丁',
    })
  }
  if (troubled.some(d => d.dimension === 'D3')) {
    actions.push({ dim: 'D3', to: 'chains', text: '看「进行中的事」里卡住/烂尾风险的链——要么推一把要么关掉' })
  }
  if (troubled.some(d => d.dimension === 'D5') && untriagedCount > 0) {
    actions.push({ dim: 'D5', to: 'signals', text: `「警报」页有 ${untriagedCount} 条未接单——挂越久越红，今天顺手归口` })
  }
  actions.push({ dim: 'D1', to: null, text: '暂时不用管分数本身——bugfix 占比降回 25% 以下，综合分会自己回到 70+' })
  return (
    <div className="rounded-2xl bg-white/70 border border-stone-200/60 px-4 py-3" data-testid="action-list">
      <p className="text-xs font-semibold text-stone-500 tracking-wide mb-2">建议动作</p>
      <ol className="space-y-1.5">
        {actions.map((a, i) => (
          <li key={i} className="text-[13px] text-stone-600 leading-relaxed flex gap-2">
            <span className="text-stone-400 shrink-0">{i + 1}.</span>
            {a.to ? (
              <EvidenceAction to={a.to}>{a.text}</EvidenceAction>
            ) : (
              <span>{a.text}</span>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

// CHANGE_TYPE_LABELS 在本文件的 D1 证据文案里引用（保持收编单一真相源）
void CHANGE_TYPE_LABELS
