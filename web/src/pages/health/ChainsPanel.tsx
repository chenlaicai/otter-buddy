/**
 * 「进行中的事」分组面板（issue #1029）——四态进度语言 + 异常排前正常折叠。
 *
 * 结构（低保真原型 p3 为设计真相源）：
 * - 顶行进度徽章：正常推进 N / 卡住 N / 烂尾风险 N（CHAIN_STATE_PROGRESS 人话标签）
 * - 异常链排最前（regressed/stalled/orphan，SwimlaneTimeline 同款严重度排序）
 * - 正常推进的链折叠在折叠区里——打开 tab 看到的是「需要注意的事」，不是 31 条平铺
 *
 * 边界：泳道组件 SwimlaneTimeline 本身不重写——本面板只做分组与折叠，
 * 异常区与折叠区各渲染一次泳道（共享同一 x 轴窗口，无新依赖）。
 */

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { RhiChainDTO } from '../../api/client'
import { SwimlaneTimeline, sortChainsBySeverity } from './SwimlaneTimeline'
import { CHAIN_STATE_PROGRESS, ANOMALY_STATES, type ChainState } from './chain-state-meta'

const TONE_BADGE: Record<string, string> = {
  ok: 'bg-teal-100 text-teal-700',
  warn: 'bg-caramel-100 text-caramel-700',
  danger: 'bg-rose-100 text-rose-700',
}

/** 分组面板：进度徽章 + 异常置顶泳道 + 正常折叠泳道 */
export function ChainsPanel({ chains, onOpen }: { chains: RhiChainDTO[]; onOpen: (id: string) => void }) {
  const [showNormal, setShowNormal] = useState(false)
  const sorted = sortChainsBySeverity(chains)
  const anomaly = sorted.filter(c => (ANOMALY_STATES as string[]).includes(c.state))
  const normal = sorted.filter(c => c.state === 'active')
  const counts = countByState(chains)
  const Chevron = showNormal ? ChevronDown : ChevronRight

  if (chains.length === 0) {
    return (
      <div className="rounded-2xl bg-white/70 border border-stone-200/60 py-12 text-center text-sm text-stone-400">
        没有进行中的事
      </div>
    )
  }

  return (
    <div className="space-y-3" data-testid="chains-panel">
      {/* 顶行进度徽章（原型：正常推进 28 / 卡住 2 / 烂尾风险 1） */}
      <div className="flex flex-wrap gap-2" data-testid="chain-progress-badges">
        {(Object.keys(CHAIN_STATE_PROGRESS) as ChainState[]).map(st => {
          const meta = CHAIN_STATE_PROGRESS[st]
          const n = counts[st] ?? 0
          if (n === 0) return null
          return (
            <span
              key={st}
              className={`px-2.5 py-1 rounded-full text-xs font-semibold ${TONE_BADGE[meta.tone]}`}
              data-testid={`progress-badge-${st}`}
              data-count={n}
            >
              {meta.label} {n}
            </span>
          )
        })}
        <span className="text-[11px] text-stone-400 self-center ml-1">
          共 {chains.length} 件 · 异常的排最前，正常推进的折叠
        </span>
      </div>

      {/* 异常区：卡住/回退/烂尾风险排最前（原型：打开 tab 先看到要注意的事） */}
      {anomaly.length > 0 && (
        <div className="rounded-2xl bg-white/70 border border-stone-200/60 px-2 py-2 overflow-x-auto" data-testid="chain-anomaly-zone">
          <SwimlaneTimeline chains={anomaly} onOpen={onOpen} />
        </div>
      )}

      {/* 正常推进：默认折叠（原型：…其余 27 条正常推进的折叠） */}
      {normal.length > 0 && (
        <div className="rounded-2xl bg-white/70 border border-stone-200/60 px-4 py-2">
          <button
            type="button"
            className="flex items-center gap-1.5 w-full text-left"
            data-testid="normal-chains-toggle"
            data-open={showNormal ? '1' : undefined}
            onClick={() => setShowNormal(v => !v)}
          >
            <Chevron className="w-3.5 h-3.5 text-stone-400" />
            <span className="text-xs font-medium text-stone-500">
              其余 {normal.length} 件正常推进（点开展开）
            </span>
          </button>
          {showNormal && (
            <div className="pt-2 overflow-x-auto" data-testid="normal-chains-list">
              <SwimlaneTimeline chains={normal} onOpen={onOpen} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function countByState(chains: RhiChainDTO[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of chains) out[c.state] = (out[c.state] ?? 0) + 1
  return out
}
