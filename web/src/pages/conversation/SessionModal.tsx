import { useState, useEffect, useCallback } from 'react'
import { X, ChevronRight, Loader2, MessageSquare, Wrench, WrenchIcon, CircleAlert, Braces } from 'lucide-react'
import type { LocalOtter } from '../../lib/mappers'
import type { InvokeDTO, InvokeEventDTO } from '@contract/api'
import { OtterAvatar } from '../../components/OtterAvatar'
import { fmtTime } from '../../lib/utils'
import { fmtInvokeElapsed, fmtTokens } from '../../lib/invoke-tracker'
import * as api from '../../api/client'

/**
 * F20260910ctlv：Session 弹窗——点击獭头像弹出，展示该獭的完整 session 记录。
 * 数据源：GET /api/conversations/:id/invokes?otterId=（invoke 列表）+
 *        GET /api/invokes/:invokeId/events（流式过程：assistant_text/tool_call/tool_result/speak）
 * 特性文档 D5：流式过程从消息气泡挪出，只在此弹窗展示。
 */

interface SessionModalProps {
  otter: LocalOtter
  conversationId: string
  onClose: () => void
}

export function SessionModal({ otter, conversationId, onClose }: SessionModalProps) {
  const [invokes, setInvokes] = useState<InvokeDTO[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 展开态：invokeId → 已加载事件（null = 未加载） */
  const [expandedEvents, setExpandedEvents] = useState<Record<string, InvokeEventDTO[] | null>>({})
  const [eventsLoading, setEventsLoading] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false
    api.listInvokes(conversationId, { otterId: otter.id, limit: 50 })
      .then(resp => { if (!cancelled) setInvokes(resp.invokes) })
      .catch(() => { if (!cancelled) setLoadError('invoke 记录加载失败') })
    return () => { cancelled = true }
  }, [conversationId, otter.id])

  /** ESC 关闭 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggleInvoke = useCallback(async (invoke: InvokeDTO) => {
    if (expandedEvents[invoke.id]) {
      setExpandedEvents(prev => { const next = { ...prev }; delete next[invoke.id]; return next })
      return
    }
    setEventsLoading(prev => ({ ...prev, [invoke.id]: true }))
    try {
      const resp = await api.getInvokeEvents(invoke.id)
      setExpandedEvents(prev => ({ ...prev, [invoke.id]: resp.events }))
    } catch {
      setExpandedEvents(prev => ({ ...prev, [invoke.id]: [] }))
    } finally {
      setEventsLoading(prev => ({ ...prev, [invoke.id]: false }))
    }
  }, [expandedEvents])

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 md:p-8"
      style={{ background: 'rgba(60,50,40,0.25)', backdropFilter: 'blur(2px)' }}
      onClick={onClose}
    >
      <div
        className="glass rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden shadow-glow"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部：獭头像 + 名字 */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/40 flex-shrink-0">
          <OtterAvatar otterId={otter.id} name={otter.name} size={36} type={otter.type} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-stone-700">{otter.name} · Session 记录</div>
            <div className="text-[11px] text-stone-400">每次行动（invoke）的完整流式过程</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full text-stone-400 hover:bg-white/40 transition" aria-label="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* invoke 列表 */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loadError && <div className="text-xs text-red-400 py-8 text-center">{loadError}</div>}
          {!loadError && invokes === null && (
            <div className="flex items-center justify-center gap-2 py-8 text-stone-400 text-xs">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中...
            </div>
          )}
          {invokes !== null && invokes.length === 0 && (
            <div className="py-8 text-center text-xs text-stone-400">该獭暂无 invoke 记录</div>
          )}
          {invokes?.map(inv => {
            const expanded = expandedEvents[inv.id] != null
            const loading = !!eventsLoading[inv.id]
            return (
              <div key={inv.id} className="glass-card rounded-2xl mb-2 overflow-hidden">
                <button
                  onClick={() => toggleInvoke(inv)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-white/30 transition"
                >
                  <ChevronRight className={`w-3.5 h-3.5 text-stone-400 transition-transform flex-shrink-0 ${expanded ? 'rotate-90' : ''}`} />
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0 ${statusBadgeClass(inv.status)}`}>
                    {statusLabel(inv.status)}
                  </span>
                  <span className="text-[11px] text-stone-500 flex-shrink-0">{fmtTime(inv.startedAt)}</span>
                  <span className="text-[10px] text-stone-400 flex-shrink-0">· {fmtInvokeElapsed(toTrackerState(inv))}</span>
                  <span className="text-[10px] text-stone-400 flex-shrink-0">· 🛠 {inv.toolCallCount}</span>
                  {inv.tokenUsageInput != null || inv.tokenUsageOutput != null ? (
                    <span className="text-[10px] text-stone-400 flex-shrink-0">
                      · {fmtTokens(inv.tokenUsageInput)}→{fmtTokens(inv.tokenUsageOutput)} tok
                    </span>
                  ) : null}
                </button>
                {expanded && (
                  <div className="border-t border-white/30 px-3 py-2">
                    {loading && (
                      <div className="flex items-center gap-2 py-3 text-stone-400 text-[11px]">
                        <Loader2 className="w-3 h-3 animate-spin" /> 加载流式过程...
                      </div>
                    )}
                    {!loading && (expandedEvents[inv.id]?.length ?? 0) === 0 && (
                      <div className="py-3 text-[11px] text-stone-400">无流式过程记录</div>
                    )}
                    {expandedEvents[inv.id]?.map(ev => <InvokeEventItem key={ev.id} ev={ev} />)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** invoke 状态徽章配色 */
function statusBadgeClass(status: InvokeDTO['status']): string {
  if (status === 'running') return 'bg-teal-400/15 text-teal-500'
  if (status === 'completed') return 'bg-otter-400/15 text-otter-500'
  if (status === 'failed') return 'bg-red-400/15 text-red-400'
  return 'bg-stone-400/15 text-stone-400'
}

function statusLabel(status: InvokeDTO['status']): string {
  if (status === 'running') return '进行中'
  if (status === 'completed') return '完成'
  if (status === 'failed') return '失败'
  return '中断'
}

/** InvokeDTO → fmtInvokeElapsed 入参形态（复用 tracker 的耗时格式化） */
function toTrackerState(inv: InvokeDTO): Parameters<typeof fmtInvokeElapsed>[0] {
  return {
    invokeId: inv.id,
    otterId: inv.otterId,
    status: inv.status,
    startedAt: inv.startedAt,
    endedAt: inv.endedAt ?? undefined,
  }
}

/** 流式过程事件条目（assistant_text/tool_call/tool_result/error/speak 按时间序） */
function InvokeEventItem({ ev }: { ev: InvokeEventDTO }) {
  const icon = ev.eventType === 'speak' ? <MessageSquare className="w-3 h-3 text-otter-400" />
    : ev.eventType === 'assistant_toolcall' ? <Wrench className="w-3 h-3 text-amber-500" />
    : ev.eventType === 'tool_result' ? <WrenchIcon className="w-3 h-3 text-amber-600" />
    : ev.eventType === 'error' ? <CircleAlert className="w-3 h-3 text-red-400" />
    : <Braces className="w-3 h-3 text-stone-400" />
  const label = ev.eventType === 'speak' ? '发言'
    : ev.eventType === 'assistant_toolcall' ? '工具调用'
    : ev.eventType === 'tool_result' ? '工具结果'
    : ev.eventType === 'error' ? '错误'
    : '思考'
  const body = eventBodyText(ev)
  return (
    <div className="flex gap-2 py-1.5 border-b border-white/20 last:border-0">
      <span className="flex-shrink-0 mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-medium text-stone-500">{label}</span>
          <span className="text-[9px] text-stone-400">{fmtTime(ev.createdAt)}</span>
        </div>
        <div className="text-[10px] text-stone-500 whitespace-pre-wrap break-all leading-relaxed mt-0.5 line-clamp-6" title={body}>{body}</div>
      </div>
    </div>
  )
}

/** 事件 payload → 展示文本（不同 eventType 的 payload 形态各异，做防御性解析） */
function eventBodyText(ev: InvokeEventDTO): string {
  const p = ev.payload ?? {}
  try {
    if (ev.eventType === 'speak') return String(p.body ?? '')
    if (ev.eventType === 'assistant_text') {
      const content = p.content
      if (Array.isArray(content)) return content.map(c => typeof c === 'object' && c !== null && 'text' in (c as Record<string, unknown>) ? String((c as Record<string, unknown>).text ?? '') : String(c)).join('')
      return String(content ?? '')
    }
    if (ev.eventType === 'assistant_toolcall') {
      const content = p.content
      if (Array.isArray(content)) return content.map(c => {
        const r = c as Record<string, unknown>
        if (typeof r.name === 'string') return `${r.name}(${JSON.stringify(r.arguments ?? r.input ?? {})})`
        return JSON.stringify(c)
      }).join('\n')
      return JSON.stringify(content ?? p)
    }
    if (ev.eventType === 'tool_result') {
      const name = typeof p.name === 'string' ? `${p.name}: ` : ''
      const r = p.result ?? p
      const text = typeof r === 'string' ? r : JSON.stringify(r)
      return name + text
    }
    if (ev.eventType === 'error') return String(p.message ?? p.error ?? JSON.stringify(p))
    return JSON.stringify(p)
  } catch {
    return '[无法解析的事件内容]'
  }
}
