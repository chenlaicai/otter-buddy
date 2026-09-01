/**
 * 复发模式卡（Issue #647 项 1，首屏主角）+ 低置信折叠抽屉（项 2）
 *
 * 复发卡：bug●(caramel-600) → fix●(teal-500) 时间轴证据链——「反复修」第一次有视觉形体。
 * 频次徽章 = commits.length 派生（后端 signal-evidence.ts 已保证），严禁 occurrences。
 * 低置信抽屉：默认收起，otter-100 底单行——高置信前景化、低置信背景化（观澜 3.1）。
 */

import { useState } from 'react'
import { ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import type { RhiSignalDTO } from '../../api/client'
import { TEAL, CARAMEL, OTTER, LAVENDER } from './palette'

export interface RecurrenceCard {
  id: number
  label: string
  filePath: string | null
  featureId: string | null
  /** 频次徽章：从证据序列长度派生（非 occurrences——扫描触发次数随频率漂移） */
  commitCount: number
  windowDays: number | null
  /** 全类型序列（bug●→fix● 交替时间轴数据源，时间升序） */
  commits: Array<{ sha: string; date: string; changeType: string | null; message: string }>
}

/** bug_recurrence 信号 → 复发卡视图模型；频次从 evidence_detail.commits 派生 */
export function toRecurrenceCard(s: RhiSignalDTO): RecurrenceCard | null {
  const d = s.evidenceDetail
  if (!d || d.kind !== 'bug_recurrence_commits' || d.commits.length === 0) return null
  return {
    id: s.id,
    label: s.signalTypeLabel,
    filePath: s.file_path,
    featureId: s.feature_id,
    commitCount: d.commits.length,
    windowDays: d.windowDays ?? null,
    commits: d.commits,
  }
}

function fmtDay(iso: string): string {
  return iso.length >= 10 ? iso.slice(5, 10).replace('-', '/') : iso
}

/** 节点：bug=caramel-600 实心、fix=teal-500 实心、其他类型=otter-300 空心（交替节奏靠色差读出） */
function nodeStyle(changeType: string | null): { fill: string; hollow: boolean; label: string } {
  if (changeType === 'BugFix') return { fill: CARAMEL[600], hollow: false, label: 'bug' }
  if (changeType === 'New Feature' || changeType === 'Feature Update') return { fill: TEAL[500], hollow: false, label: 'feat' }
  return { fill: OTTER[300], hollow: true, label: changeType ?? 'commit' }
}

/** 单卡：头部（文件 + 频次徽章 + 模式标签）+ 水平时间轴（bug●/fix● 交替） */
export function RecurrenceCardView({ card }: { card: RecurrenceCard }) {
  return (
    <div className="rounded-xl bg-white/70 border border-caramel-300/60 px-4 py-3" data-testid="recurrence-card">
      <div className="flex items-center gap-2 flex-wrap">
        <AlertTriangle className="w-3.5 h-3.5 text-caramel-600 shrink-0" />
        <span className="font-mono text-sm font-medium text-otter-900 truncate" title={card.filePath ?? ''}>
          {card.filePath ?? card.featureId ?? '未知文件'}
        </span>
        <span
          className="px-1.5 py-0.5 rounded text-xs font-semibold text-white shrink-0"
          style={{ backgroundColor: CARAMEL[600] }}
          data-testid="recurrence-badge"
        >
          {card.commitCount} 次/{card.windowDays ?? 30} 天
        </span>
        <span
          className="px-1.5 py-0.5 rounded text-xs shrink-0 border"
          style={{ color: LAVENDER[500], borderColor: LAVENDER[400] }}
        >
          设计问题嫌疑
        </span>
      </div>
      {/* 水平时间轴：节点绝对定位按日期在 [first, last] 区间线性映射（观澜 3.1 灵魂形态） */}
      <RecurrenceTimeline card={card} />
    </div>
  )
}

function RecurrenceTimeline({ card }: { card: RecurrenceCard }) {
  const commits = card.commits
  if (commits.length === 0) return null
  const first = new Date(commits[0]!.date).getTime()
  const last = new Date(commits[commits.length - 1]!.date).getTime()
  const span = Math.max(last - first, 1)
  const nodes = commits.map(c => {
    const t = new Date(c.date).getTime()
    const pct = ((t - first) / span) * 100
    const style = nodeStyle(c.changeType)
    return { ...c, pct, style }
  })
  return (
    <div className="mt-2.5 px-1" data-testid="recurrence-timeline">
      <div className="relative h-10">
        {/* 基线 */}
        <div className="absolute left-0 right-0 top-5 h-px" style={{ backgroundColor: OTTER[300] }} />
        {nodes.map(n => (
          <div
            key={n.sha}
            className="absolute flex flex-col items-center"
            style={{ left: `${n.pct}%`, transform: 'translateX(-50%)' }}
            title={`${fmtDay(n.date)} ${n.style.label} ${n.sha} · ${n.message}`}
          >
            <span className="text-[10px] leading-none text-stone-400 mb-0.5">{fmtDay(n.date)}</span>
            <span
              className="w-2.5 h-2.5 rounded-full border-2 border-white"
              style={{ backgroundColor: n.style.fill, boxShadow: `0 0 0 1px ${n.style.fill}` }}
            />
            <span className="text-[10px] leading-none mt-0.5" style={{ color: n.style.fill }}>{n.style.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 复发卡列表（首屏主角）：无模式时给确定感空态（观澜：teal 勾 + 一句话） */
export function RecurrenceSection({ signals }: { signals: RhiSignalDTO[] }) {
  const cards = signals.map(toRecurrenceCard).filter((c): c is RecurrenceCard => c !== null)
  if (cards.length === 0) {
    return (
      <div className="rounded-2xl bg-white/70 border border-teal-300/50 px-4 py-5 text-center" data-testid="recurrence-empty">
        <span className="text-teal-600 font-medium text-sm">✓ 近 30 天无复发模式</span>
        <p className="text-xs text-stone-400 mt-1">同文件反复修 bug 的模式会出现在这里</p>
      </div>
    )
  }
  return (
    <div className="space-y-2.5">
      {cards.slice(0, 5).map(c => <RecurrenceCardView key={c.id} card={c} />)}
      {cards.length > 5 && (
        <p className="text-xs text-stone-400 text-center">其余 {cards.length - 5} 个复发模式见「信号」tab</p>
      )}
    </div>
  )
}

/** 低置信折叠抽屉（项 2）：默认收起不稀释真警报；otter-100 底单行，描边徽章降一级 */
export function LowConfidenceDrawer({ signals, defaultOpen = false }: {
  signals: RhiSignalDTO[]
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  if (signals.length === 0) return null
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div className="rounded-xl bg-otter-100/70 border border-otter-200 px-3 py-2" data-testid="low-confidence-drawer">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 w-full text-left"
        data-testid="low-confidence-toggle"
      >
        <Chevron className="w-3.5 h-3.5 text-otter-600" />
        <span className="text-xs font-medium text-otter-700">
          低置信信号（{signals.length}）· 待核验，不计入警报
        </span>
      </button>
      {open && (
        <div className="mt-2 divide-y divide-otter-200" data-testid="low-confidence-list">
          {signals.map(s => (
            <div key={s.id} className="py-1.5 flex items-center gap-2 flex-wrap">
              {/* 描边徽章（非实心）：低置信在视觉语法上降一级，不透支警示色信用 */}
              <span className="px-1.5 py-0.5 rounded text-[11px] border border-caramel-500 text-caramel-600">
                {s.severity}
              </span>
              <span className="text-xs font-medium text-stone-600">{s.signalTypeLabel}</span>
              {s.feature_id && <span className="font-mono text-[11px] text-stone-400">{s.feature_id}</span>}
              <span className="text-[11px] text-stone-400 flex-1 min-w-[120px] truncate" title={s.evidence}>{s.evidence}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
