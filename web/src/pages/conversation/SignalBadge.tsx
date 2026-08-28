import { useState } from 'react'
import type { LocalMessageSignal } from '../../lib/mappers'

/**
 * F20260826mwrd C4：獭间信号徽章——消息原位渲染 <signal> 块的视觉表达。
 *
 * 分档（母方案 Part 5）：
 * - objection/blocked：常规徽章，点击展开 payload 正文
 * - halt：高亮徽章（谁停了谁）
 * - 状态机：pending（橙）→ resolved（绿，显示裁决摘要）/ dismissed（灰，显示理由）
 */

const TYPE_META: Record<LocalMessageSignal['type'], { icon: string; label: string }> = {
  objection: { icon: '⚡', label: 'objection' },
  blocked: { icon: '🚧', label: 'blocked' },
  halt: { icon: '⛔', label: 'halt' },
}

const STATUS_META: Record<LocalMessageSignal['status'], { label: string; cls: string }> = {
  pending: { label: '未裁决', cls: 'bg-amber-100 text-amber-800 border-amber-300' },
  resolved: { label: '已裁决', cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
  dismissed: { label: '已驳回', cls: 'bg-stone-200 text-stone-600 border-stone-300' },
}

export function SignalBadge({ signal, fromName }: { signal: LocalMessageSignal; fromName?: string }) {
  const [open, setOpen] = useState(false)
  const t = TYPE_META[signal.type]
  const s = STATUS_META[signal.status]
  // halt 落账即 resolved（system 自动闭环）——徽章显示「已执行」而非「已裁决」
  const statusLabel = signal.type === 'halt' && signal.status === 'resolved' ? '已执行' : s.label
  const haltCls = signal.type === 'halt' ? 'border-red-300 bg-red-50' : s.cls

  return (
    <div className="my-1 text-xs" data-testid="signal-badge">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition-colors hover:brightness-95 ${haltCls}`}
        aria-expanded={open}
      >
        <span>{t.icon}</span>
        <span className="font-medium">{t.label}</span>
        <span className="opacity-70">· {statusLabel}</span>
        {signal.type === 'halt' && fromName && <span className="opacity-70">· {fromName} 发起</span>}
      </button>
      {open && (
        <div className="mt-1 max-w-md rounded-xl border border-stone-200 bg-white/80 px-3 py-2 leading-relaxed text-stone-600">
          {signal.type === 'halt' && signal.targetName && (
            <p className="mb-1"><span className="font-medium">目标：</span>{signal.targetName}</p>
          )}
          <p className="whitespace-pre-wrap">{signal.payload}</p>
          {signal.resolution && (
            <p className="mt-1 border-t border-stone-100 pt-1">
              <span className="font-medium">{signal.status === 'dismissed' ? '驳回理由' : '裁决'}：</span>
              {signal.resolution}
            </p>
          )}
          <p className="mt-1 text-[10px] opacity-50">{signal.createdAt}</p>
        </div>
      )}
    </div>
  )
}
