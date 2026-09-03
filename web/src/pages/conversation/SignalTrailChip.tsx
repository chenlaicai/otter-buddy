import { useState } from 'react'
import type { LocalOtter } from '../../lib/mappers'
import { trailStateMeta, trailLevelMeta, type TrailItem } from '../../lib/signal-trail'

/**
 * 信号轨迹条（F20260902u5tr）：投石信号消息上的「谁→谁 · 档位 · 状态」原位展示。
 *
 * 交互契约（#695 大獭裁决）：
 * - busy+PENDING 显示「排队待消化」而非「已送达」，CONSUMED 才显示「已处理」
 * - 措辞不说「正在忙」（busy 判定是近似）、不显示队列位置（内存态重启会说谎）
 * - 状态由服务端推导，本组件零推导——props 变化即重渲染，重启前后一致
 */
export function SignalTrailChip({ items, otters }: { items: TrailItem[]; otters: LocalOtter[] }) {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null

  // 汇总态优先级：FAILED > CONSUMING > PENDING > CONSUMED（最需要用户注意的态优先；
  // 失败不可被其它目标正常态掩盖——失败可见是 S1b 验收③）
  const worst = items.find(i => i.state === 'FAILED') ?? items.find(i => i.state === 'CONSUMING')
    ?? items.find(i => i.state === 'PENDING')
  // S3.5 弱化（G8/A 方案）：汇总徽标默认只图标（FAILED/高优档豁免），展开详情行全文字
  const summary = worst
    ? trailStateMeta(worst.state, worst.level, worst.note, true)
    : trailStateMeta('CONSUMED', items[0].level, null, true)

  return (
    <div className="my-1 text-xs" data-testid="signal-trail">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition-colors hover:brightness-95 ${summary.cls}`}
        aria-expanded={open}
        title={summary.title}
      >
        <span>{summary.icon}</span>
        <span className="font-medium">{summary.label}</span>
        <span className="opacity-60">· 信号轨迹 {items.length}</span>
      </button>
      {open && (
        <div className="mt-1 max-w-md rounded-xl border border-stone-200 bg-white/80 px-3 py-2 leading-relaxed text-stone-600 space-y-1">
          {items.map(i => {
            const meta = trailStateMeta(i.state, i.level, i.note) // 详情行不弱化（全文字）
            const lv = trailLevelMeta(i.level)
            const targetName = otters.find(o => o.id === i.targetOtterId)?.name ?? i.targetOtterId.slice(0, 8)
            const fromName = i.fromType === 'user' ? '用户' : (otters.find(o => o.id === i.fromId)?.name ?? i.fromId.slice(0, 8))
            return (
              <div key={`${i.messageId}:${i.targetOtterId}`} className="flex items-center gap-1.5 flex-wrap">
                <span className={`rounded px-1 text-[10px] font-medium ${lv.cls}`}>{lv.label}</span>
                <span className="font-medium">{fromName}</span>
                <span className="opacity-50">→</span>
                <span className="font-medium">{targetName}</span>
                <span className={`rounded-full border px-1.5 text-[10px] ${meta.cls}`}>{meta.icon} {meta.label}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
