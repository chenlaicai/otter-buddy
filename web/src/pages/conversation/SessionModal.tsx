import { useState, useEffect, useCallback, useRef } from 'react'
import { X, ChevronRight, Loader2, MessageSquare, Wrench, CircleAlert, Braces, Terminal } from 'lucide-react'
import type { LocalOtter } from '../../lib/mappers'
import type { InvokeDTO, InvokeEventDTO } from '@contract/api'
import { OtterAvatar } from '../../components/OtterAvatar'
import { fmtTime } from '../../lib/utils'
import { fmtInvokeElapsed, fmtTokens, fmtCtx } from '../../lib/invoke-tracker'
import { foldInvokeEvents, type FoldedStep } from '../../lib/invoke-event-fold'
import * as api from '../../api/client'

/**
 * F20260913ctlv：Session 弹窗——点击獭头像弹出，展示该獭的完整 session 记录。
 * 数据源：GET /api/conversations/:id/invokes?otterId=（invoke 列表）+
 *        GET /api/invokes/:invokeId/events（流式过程：assistant_text/tool_call/tool_result/speak）
 * 特性文档 D5：流式过程从消息气泡挪出，只在此弹窗展示。
 *
 * F20260914rtsp 升级：
 * - 自动展开最新 invoke（running 优先，否则最新一条）——打开即看当前行动，不用手点
 * - running invoke 2s 轮询增量尾随（新事件 append + 自动滚底，上滚暂停跟随）
 * - 事件展示层折叠（invoke-event-fold）：同一次工具调用「调用→结果」一行，点开看原始分列
 * - 终态 invoke 加载 limit 300 兜底（防长 invoke 卡顿；上翻分页留后续迭代）
 */

interface SessionModalProps {
  otter: LocalOtter
  conversationId: string
  onClose: () => void
}

/** 终态 invoke 事件加载上限（F20260914rtsp D9） */
const TERMINAL_EVENTS_LIMIT = 300

export function SessionModal({ otter, conversationId, onClose }: SessionModalProps) {
  const [invokes, setInvokes] = useState<InvokeDTO[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 展开态：invokeId → 已加载事件（null = 未加载） */
  const [expandedEvents, setExpandedEvents] = useState<Record<string, InvokeEventDTO[] | null>>({})
  const [eventsLoading, setEventsLoading] = useState<Record<string, boolean>>({})
  /** call 步原始分列展开态：`${invokeId}:${stepIndex}` → true */
  const [rawExpanded, setRawExpanded] = useState<Record<string, boolean>>({})
  /** 轮询驱动的 invoke 状态镜像（发现终态化即停轮询） */
  const [polledStatus, setPolledStatus] = useState<Record<string, InvokeDTO['status']>>({})
  const eventsBoxRef = useRef<HTMLDivElement | null>(null)
  /** 自动滚底跟随：用户上滚（距底 > 40px）暂停，回底恢复 */
  const followBottomRef = useRef(true)

  useEffect(() => {
    let cancelled = false
    api.listInvokes(conversationId, { otterId: otter.id, limit: 50 })
      .then(resp => {
        if (cancelled) return
        setInvokes(resp.invokes)
        /** F20260914rtsp：自动展开最新 invoke（running 优先，否则第一条） */
        const target = resp.invokes.find(i => i.status === 'running') ?? resp.invokes[0]
        if (target) {
          setExpandedEvents(prev => ({ ...prev, [target.id]: null }))
          setEventsLoading(prev => ({ ...prev, [target.id]: true }))
          api.getInvokeEvents(target.id)
            .then(r => { if (!cancelled) setExpandedEvents(prev => ({ ...prev, [target.id]: r.events })) })
            .catch(() => { if (!cancelled) setExpandedEvents(prev => ({ ...prev, [target.id]: [] })) })
            .finally(() => { if (!cancelled) setEventsLoading(prev => ({ ...prev, [target.id]: false })) })
        }
      })
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

  /** F20260914rtsp：running invoke 2s 轮询增量尾随。
   *  停止条件：展开态消失（用户收起/关弹窗 unmount）或 invoke 终态化（镜像状态非 running）。 */
  /** F20260914rtsp：running invoke 2s 轮询增量尾随。停止条件：展开态消失（收起/关弹窗）或终态化。
 *  runningExpanded 布尔锤：轮询自身写 expandedEvents（对象引用必变），若把对象进依赖
 *  每 tick 重建 interval（审视发现 1）——布尔恒稳定，收起/展开仍正确启停 */
  const runningInvokeId = invokes?.find(i => (polledStatus[i.id] ?? i.status) === 'running')?.id
  const runningExpanded = runningInvokeId != null && expandedEvents[runningInvokeId] !== undefined
  useEffect(() => {
    if (!runningInvokeId || !runningExpanded) return
    const timer = setInterval(async () => {
      try {
        const resp = await api.getInvokeEvents(runningInvokeId)
        setExpandedEvents(prev => {
          const cur = prev[runningInvokeId]
          if (cur == null) return prev
          if (cur.length >= resp.events.length) return prev
          return { ...prev, [runningInvokeId]: resp.events }
        })
        if (resp.invoke.status !== 'running') {
          setPolledStatus(prev => ({ ...prev, [runningInvokeId]: resp.invoke.status }))
          /** 终态化：同步刷新 invoke 列表行（状态/统计） */
          setInvokes(prev => prev?.map(i => i.id === resp.invoke.id ? resp.invoke : i) ?? prev)
        }
      } catch { /* 轮询失败静默（下轮重试）；连续失败由弹窗关闭自然停止 */ }
    }, 2000)
    return () => clearInterval(timer)
    // 审视发现 1 处置：依赖布尔派生值而非 expandedEvents 对象——轮询 append 事件时对象引用
    // 必变但 runningExpanded 恒 true，interval 不被重建；收起/展开 running invoke 仍正确启停
    // （直接去掉 expandedEvents 依赖会丢失启停语义：收起再展开后轮询不会重启——故用布尔锚）
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runningExpanded 已涵盖 expandedEvents 的启停语义
  }, [runningInvokeId, runningExpanded])

  /** 自动滚底（followBottomRef 跟随中才滚） */
  useEffect(() => {
    if (followBottomRef.current && eventsBoxRef.current) {
      eventsBoxRef.current.scrollTop = eventsBoxRef.current.scrollHeight
    }
  }, [expandedEvents])

  const handleScroll = useCallback(() => {
    const el = eventsBoxRef.current
    if (!el) return
    followBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])

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
          {otter.modelAlias && (
            <span data-testid="model-badge" className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-stone-400/15 text-stone-500">
              {otter.modelAlias}{otter.modelIsDefault && <span className="text-stone-400">（默认）</span>}
            </span>
          )}
          <button onClick={onClose} className="p-1.5 rounded-full text-stone-400 hover:bg-white/40 transition" aria-label="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* invoke 列表 */}
        <div className="flex-1 overflow-y-auto px-5 py-4" ref={eventsBoxRef} onScroll={handleScroll}>
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
            const isRunning = (polledStatus[inv.id] ?? inv.status) === 'running'
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
                  {/* F20260914rtsp：ctx 窗口占用（usage.totalTokens 快照；null = 旧数据/未发射） */}
                  {inv.ctxWindowUsed != null && (
                    <span className="text-[10px] text-stone-400 flex-shrink-0">· ⬛ {fmtCtx(inv.ctxWindowUsed)}</span>
                  )}
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
                    {/* F20260914rtsp：折叠视图（invoke-event-fold 归并；原始分列点 call 步展开）。
                        存储忠实保留原始流——折叠仅渲染层，rawEventIds 溯源 */}
                    {!loading && (expandedEvents[inv.id] ?? []).length > TERMINAL_EVENTS_LIMIT && !isRunning && (
                      <div className="py-1 text-[10px] text-stone-400">事件较多，仅展示最近 {TERMINAL_EVENTS_LIMIT} 条（上翻分页见后续迭代）</div>
                    )}
                    {!loading && foldInvokeEvents(visibleEvents(expandedEvents[inv.id] ?? [], isRunning)).map((step, idx) => (
                      <FoldedStepItem
                        key={`${inv.id}:${idx}`}
                        invokeId={inv.id}
                        stepIndex={idx}
                        step={step}
                        rawEvents={expandedEvents[inv.id] ?? []}
                        rawExpanded={!!rawExpanded[`${inv.id}:${idx}`]}
                        onToggleRaw={() => setRawExpanded(prev => ({ ...prev, [`${inv.id}:${idx}`]: !prev[`${inv.id}:${idx}`] }))}
                      />
                    ))}
                    {isRunning && (
                      <div className="flex items-center gap-2 py-2 text-[10px] text-teal-500" data-testid="live-follow-indicator">
                        <span className="flex gap-0.5">
                          <i className="w-0.5 h-2 bg-teal-400 rounded animate-pulse" />
                          <i className="w-0.5 h-2 bg-teal-400 rounded animate-pulse" style={{ animationDelay: '0.2s' }} />
                          <i className="w-0.5 h-2 bg-teal-400 rounded animate-pulse" style={{ animationDelay: '0.4s' }} />
                        </span>
                        实时尾随中 · 上滚暂停，回底恢复
                      </div>
                    )}
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

/** 终态 invoke 事件量兜底：running 全量（轮询需要完整集）；终态截最近 N 条 */
function visibleEvents(events: InvokeEventDTO[], isRunning: boolean): InvokeEventDTO[] {
  if (isRunning || events.length <= TERMINAL_EVENTS_LIMIT) return events
  return events.slice(-TERMINAL_EVENTS_LIMIT)
}

/** 折叠步渲染（call 可展开原始分列） */
function FoldedStepItem({ step, rawEvents, rawExpanded, onToggleRaw }: {
  invokeId: string
  stepIndex: number
  step: FoldedStep
  rawEvents: InvokeEventDTO[]
  rawExpanded: boolean
  onToggleRaw: () => void
}) {
  if (step.kind === 'call') {
    const statusDot = step.pending
      ? <span className="w-1.5 h-1.5 rounded-full bg-caramel-400 animate-pulse flex-shrink-0 mt-1" title="执行中" />
      : step.isError
        ? <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0 mt-1" title="失败" />
        : <span className="w-1.5 h-1.5 rounded-full bg-teal-400 flex-shrink-0 mt-1" title="成功" />
    return (
      <div className="py-1 border-b border-white/20 last:border-0">
        <div
          className="flex gap-2 items-start cursor-pointer hover:bg-white/20 rounded-lg px-1 -mx-1 transition"
          onClick={onToggleRaw}
          data-testid="folded-call-step"
        >
          {statusDot}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <Wrench className="w-3 h-3 text-amber-500 flex-shrink-0" />
              <span className="text-[10px] font-medium text-stone-600">{step.name}</span>
              <span className="text-[9px] text-stone-400 truncate max-w-[280px]">{callArgsSummary(step.args)}</span>
              {step.pending
                ? <span className="text-[9px] text-caramel-500">执行中…</span>
                : <>
                    {step.tsEnd && <span className="text-[9px] text-stone-400">· {fmtTime(step.tsEnd)}</span>}
                    <span className="text-[9px] text-stone-400 truncate max-w-[200px]">{resultSummary(step.result)}</span>
                  </>}
            </div>
          </div>
          <ChevronRight className={`w-3 h-3 text-stone-300 flex-shrink-0 mt-1 transition-transform ${rawExpanded ? 'rotate-90' : ''}`} />
        </div>
        {rawExpanded && (
          <div className="ml-4 mt-1 pl-2 border-l-2 border-white/40 space-y-1">
            {step.rawEventIds.map(id => {
              const ev = rawEvents.find(e => e.id === id)
              return ev ? <RawEventLine key={id} ev={ev} /> : null
            })}
          </div>
        )}
      </div>
    )
  }
  if (step.kind === 'think') {
    return (
      <div className="flex gap-2 py-1 border-b border-white/20 last:border-0">
        <Braces className="w-3 h-3 text-stone-400 flex-shrink-0 mt-1" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-medium text-stone-500 italic">思考</span>
            <span className="text-[9px] text-stone-400">{fmtTime(step.ts)}</span>
          </div>
          <div className="text-[10px] text-stone-500 italic whitespace-pre-wrap break-all leading-relaxed mt-0.5 line-clamp-6" title={step.text}>{step.text}</div>
        </div>
      </div>
    )
  }
  if (step.kind === 'speak') {
    return (
      <div className="flex gap-2 py-1 border-b border-white/20 last:border-0 rounded-lg" style={{ background: 'rgba(180,131,106,0.08)' }}>
        <MessageSquare className="w-3 h-3 text-otter-400 flex-shrink-0 mt-1 ml-1" />
        <div className="min-w-0 flex-1 mr-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-medium text-otter-600">发言</span>
            <span className="text-[9px] text-stone-400">{fmtTime(step.ts)}</span>
          </div>
          <div className="text-[10px] text-stone-600 whitespace-pre-wrap break-all leading-relaxed mt-0.5 line-clamp-6" title={step.body}>{step.body}</div>
        </div>
      </div>
    )
  }
  return (
    <div className="flex gap-2 py-1 border-b border-white/20 last:border-0">
      <CircleAlert className="w-3 h-3 text-red-400 flex-shrink-0 mt-1" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-medium text-red-400">错误</span>
          <span className="text-[9px] text-stone-400">{fmtTime(step.ts)}</span>
        </div>
        <div className="text-[10px] text-red-400/80 whitespace-pre-wrap break-all leading-relaxed mt-0.5">{step.message}</div>
      </div>
    </div>
  )
}

/** 原始分列行（折叠步展开可见——溯源用，忠实原始流） */
function RawEventLine({ ev }: { ev: InvokeEventDTO }) {
  const label = ev.eventType === 'assistant_toolcall' ? 'tool_call_start' : ev.eventType === 'tool_result' ? 'tool_result' : ev.eventType
  return (
    <div className="flex gap-1.5 items-start">
      <Terminal className="w-2.5 h-2.5 text-stone-300 flex-shrink-0 mt-1" />
      <div className="min-w-0">
        <span className="text-[9px] text-stone-400 font-medium">{label}</span>
        <span className="text-[9px] text-stone-400"> · {fmtTime(ev.createdAt)}</span>
        <div className="text-[9px] text-stone-400 whitespace-pre-wrap break-all leading-relaxed line-clamp-8">{JSON.stringify(ev.payload).slice(0, 600)}</div>
      </div>
    </div>
  )
}

/** call 步参数摘要 */
function callArgsSummary(args: unknown): string {
  if (args == null) return ''
  try {
    const s = typeof args === 'string' ? args : JSON.stringify(args)
    return s.length > 80 ? `${s.slice(0, 80)}…` : s
  } catch { return '' }
}

/** call 步结果摘要 */
function resultSummary(result: unknown): string {
  if (result == null) return ''
  try {
    if (typeof result === 'string') return result.length > 60 ? `${result.slice(0, 60)}…` : result
    const r = result as Record<string, unknown>
    if (typeof r.output === 'string') return r.output.length > 60 ? `${r.output.slice(0, 60)}…` : r.output
    const s = JSON.stringify(result)
    return s.length > 60 ? `${s.slice(0, 60)}…` : s
  } catch { return '' }
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
