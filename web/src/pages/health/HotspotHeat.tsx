/**
 * 热点文件热力条（Issue #647 项 3）+ 趋势 sparkline（项 4）
 *
 * 热力条：修复频次 → teal(低)→caramel(高) 色阶映射，「热」要有热的样子（观澜 3.3）。
 * sparkline：首屏只留一行高度的走势条（趋势数据不丢——可展开完整趋势图），
 * 让位复发模式卡的首屏空间（首屏 40% 高度）。
 */

import { useState } from 'react'
import { ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts'
import { TrendingUp, ChevronDown, ChevronRight } from 'lucide-react'
import type { RhiTrendsDTO } from '../../api/client'
import { TEAL, CARAMEL, OTTER, STONE } from './palette'

export interface FileHotspot {
  file: string
  count: number
}

function fmtFileName(f: string): string {
  const parts = f.split('/')
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : f
}

/** teal→caramel 线性插值（t∈[0,1]）：低频偏 teal，高频偏 caramel */
function heatColor(t: number): string {
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t)
  const r = mix(0x3A, 0xC9), g = mix(0x8B, 0x95), b = mix(0x8B, 0x6B)
  return `rgb(${r},${g},${b})`
}

/** 热力条：横向条形，色深按频次归一映射 */
export function HotspotHeatBar({ hotspots, max = 8 }: { hotspots: FileHotspot[]; max?: number }) {
  if (hotspots.length === 0) {
    return <div className="py-4 text-center text-sm text-stone-400">无热点数据</div>
  }
  const top = hotspots.slice(0, max)
  const maxCount = Math.max(...top.map(h => h.count), 1)
  return (
    <div className="space-y-1.5" data-testid="hotspot-heat-bar">
      {top.map(h => {
        const t = (h.count - 1) / Math.max(maxCount - 1, 1) // 归一到 [0,1]
        return (
          <div key={h.file} className="flex items-center gap-2">
            <span className="font-mono text-xs text-stone-500 w-48 truncate text-right" title={h.file}>{fmtFileName(h.file)}</span>
            <div className="flex-1 h-4 rounded bg-otter-100/60 overflow-hidden">
              <div
                className="h-full rounded transition-all"
                style={{ width: `${Math.max((h.count / maxCount) * 100, 6)}%`, backgroundColor: heatColor(t) }}
              />
            </div>
            <span className="text-xs text-stone-500 w-10 tabular-nums">{h.count} 次</span>
          </div>
        )
      })}
      <div className="flex items-center gap-1.5 justify-end pt-1">
        <span className="text-[10px] text-stone-400">低</span>
        <span className="w-16 h-2 rounded" style={{ background: `linear-gradient(90deg, ${TEAL[500]}, ${CARAMEL[500]})` }} />
        <span className="text-[10px] text-stone-400">修改频次高</span>
      </div>
    </div>
  )
}

/** 从 trends DTO 提取 30 天热点（已有 distribution 行，零后端改动） */
export function hotspotData(trends: RhiTrendsDTO | null): FileHotspot[] {
  const hs = trends?.distributions.file_hotspots
  if (!Array.isArray(hs)) return []
  return hs.map(h => ({ file: h.file, count: h.count })).sort((a, b) => b.count - a.count)
}

/** sparkline：一行高（48px）走势 + 卡头小字（「近 30 天 N commits」）——背景化不抢戏 */
export function TrendSparkline({ trends }: { trends: RhiTrendsDTO | null }) {
  const [expanded, setExpanded] = useState(false)
  const series = trends?.series ?? []
  if (series.length === 0) return null
  const total = series.reduce((s, p) => s + (p.total_commits ?? 0), 0)
  const Chevron = expanded ? ChevronDown : ChevronRight
  const xStart = series[0]!.date.slice(5).replace('-', '/')
  return (
    <div className="rounded-2xl bg-white/70 border border-stone-200/60 px-4 py-3" data-testid="trend-sparkline">
      <button className="flex items-center gap-1.5 w-full text-left" onClick={() => setExpanded(v => !v)}>
        <Chevron className="w-3.5 h-3.5 text-stone-400" />
        <TrendingUp className="w-4 h-4" style={{ color: OTTER[500] }} />
        <span className="text-xs font-semibold text-stone-600">提交趋势</span>
        <span className="text-xs text-stone-400">· 近 30 天 {total} commits（自 {xStart} 起）· 点击展开详情</span>
      </button>
      <div style={{ height: expanded ? 220 : 48 }} className="mt-1 transition-all">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            {expanded && <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />}
            {expanded && <XAxis dataKey="date" tickFormatter={(v: string) => v.slice(5).replace('-', '/')} tick={{ fontSize: 11, fill: STONE[500] }} />}
            {expanded && <YAxis yAxisId="left" tick={{ fontSize: 11, fill: STONE[500] }} />}
            {expanded && <YAxis yAxisId="right" orientation="right" unit="%" domain={[0, 100]} tick={{ fontSize: 11, fill: STONE[500] }} />}
            {expanded && <Tooltip labelFormatter={l => `快照 ${String(l).slice(5).replace('-', '/')}`} />}
            {expanded && <Legend wrapperStyle={{ fontSize: 12 }} />}
            <Bar yAxisId="left" dataKey="total_commits" name="提交数" fill={OTTER[200]} radius={[2, 2, 0, 0]} />
            {/* BugFix 比率是中性指标——禁警示红（色彩纪律 1），用 caramel-500 */}
            <Line yAxisId="right" type="monotone" dataKey="bugfix_ratio" name="BugFix 比率" stroke={CARAMEL[500]} strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
