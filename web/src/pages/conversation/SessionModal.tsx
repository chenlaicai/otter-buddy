import { useState, useEffect, useCallback, useRef, type MutableRefObject } from 'react'
import { X, ChevronRight, Loader2, MessageSquare, Wrench, CircleAlert, Braces, Copy, Check } from 'lucide-react'
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
 * F20260914rtsp 升级：自动展开最新 invoke + 事件展示层折叠（invoke-event-fold）。
 * F20260914evdz 升级：
 * - 实时化改事件驱动（替换 #916 的 2s 轮询）：SSE invoke.event 经 props 注入的
 *   live 通道（index.tsx 常驻 SSE 连接转发）增量 append——推送节奏 = 獭干活的真实
 *   节奏，无任何定时器；主界面不渲染该事件（零 re-render）
 * - invoke.start → 列表自动冒出新行并自动展开；invoke 终态 → 全量拉取收敛（防乱序）
 * - 事件行展开区找回旧版（#886 前「流式过程」面板）形态：参数/结果/发言/思考全文
 *   （可滚动 + 复制按钮），替换 #916 的原始 JSON 截断分列
 */

/** 实时通道条目（index.tsx 常驻 SSE 注入；ev=null 表示 invoke 终态 flush） */
export interface SessionLiveItem {
  invokeId: string
  otterId: string
  ev: InvokeEventDTO | null
  /** invoke.start 信号（新行动开始） */
  start?: boolean
  /** SSE 连接状态变化 */
  conn?: boolean
}

interface SessionModalProps {
  otter: LocalOtter
  conversationId: string
  onClose: () => void
  /** 实时事件 buffer（挂载时回放积压；弹窗关闭期间事件不丢） */
  liveEvents: MutableRefObject<SessionLiveItem[]>
  /** 实时事件订阅者集合（挂载注册/卸载注销） */
  liveListeners: MutableRefObject<Set<(item: SessionLiveItem) => void>>
}

/** 终态 invoke 事件加载上限（F20260914rtsp D9） */
const TERMINAL_EVENTS_LIMIT = 300

export function SessionModal({ otter, conversationId, onClose, liveEvents, liveListeners }: SessionModalProps) {
  const [invokes, setInvokes] = useState<InvokeDTO[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 展开态：invokeId → 已加载事件（null = 未加载） */
  const [expandedEvents, setExpandedEvents] = useState<Record<string, InvokeEventDTO[] | null>>({})
  const [eventsLoading, setEventsLoading] = useState<Record<string, boolean>>({})
  /** 折叠步展开态：`${invokeId}:${stepIndex}` → true（展开=全文区） */
  const [rawExpanded, setRawExpanded] = useState<Record<string, boolean>>({})
  /** 实时通道驱动的 invoke 状态镜像（终态 flush 时更新） */
  const [liveStatus, setLiveStatus] = useState<Record<string, InvokeDTO['status']>>({})
  /** SSE 连接状态（断连兜底提示——不静默装实时） */
  const [connLost, setConnLost] = useState(false)
  const eventsBoxRef = useRef<HTMLDivElement | null>(null)
  /** 自动滚底跟随：用户上滚（距底 > 40px）暂停，回底恢复 */
  const followBottomRef = useRef(true)

  /** 全量拉取收敛（终态 flush / 断连恢复用——落库是真相源） */
  const refreshEvents = useCallback(async (invokeId: string) => {
    try {
      const resp = await api.getInvokeEvents(invokeId)
      setExpandedEvents(prev => (prev[invokeId] == null ? prev : { ...prev, [invokeId]: resp.events }))
      setLiveStatus(prev => ({ ...prev, [invokeId]: resp.invoke.status }))
      setInvokes(prev => prev?.map(i => i.id === resp.invoke.id ? resp.invoke : i) ?? prev)
    } catch { /* 全量收敛失败静默——live 增量仍在推 */ }
  }, [])

  /** 刷新 invoke 列表（invoke.start 信号：新行动自动冒行 + 自动展开） */
  const refreshInvokes = useCallback(async (autoExpandInvokeId?: string) => {
    try {
      const resp = await api.listInvokes(conversationId, { otterId: otter.id, limit: 50 })
      setInvokes(resp.invokes)
      const target = autoExpandInvokeId ? resp.invokes.find(i => i.id === autoExpandInvokeId) : undefined
      if (target) {
        setExpandedEvents(prev => ({ ...prev, [target.id]: null }))
        setEventsLoading(prev => ({ ...prev, [target.id]: true }))
        try {
          const r = await api.getInvokeEvents(target.id)
          setExpandedEvents(prev => ({ ...prev, [target.id]: r.events }))
        } catch { setExpandedEvents(prev => ({ ...prev, [target.id]: [] })) }
        finally { setEventsLoading(prev => ({ ...prev, [target.id]: false })) }
      }
    } catch { /* 列表刷新失败静默 */ }
  }, [conversationId, otter.id])

  useEffect(() => {
    let cancelled = false
    api.listInvokes(conversationId, { otterId: otter.id, limit: 50 })
      .then(resp => {
        if (cancelled) return
        setInvokes(resp.invokes)
        /** 自动展开最新 invoke（running 优先，否则第一条） */
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

  /** F20260914evdz：实时通道接线（事件驱动，替换 #916 的 2s 轮询）。
   *  挂载：注册监听 + 回放积压 buffer（弹窗打开前的事件不丢）；
   *  收到增量：仅追加到「已展开」的 invoke（seq 单调防乱序）；
   *  终态 flush（ev=null）：全量拉取收敛；
   *  invoke.start（start=true）：刷新列表 + 自动展开新行动；
   *  conn：SSE 连接状态（断连提示）。 */
  useEffect(() => {
    const listener = (item: SessionLiveItem) => {
      if (item.conn !== undefined) { setConnLost(!item.conn); return }
      if (item.otterId !== otter.id) return
      if (item.start) { void refreshInvokes(item.invokeId); return }
      if (item.ev == null) { void refreshEvents(item.invokeId); return }
      const ev = item.ev
      setExpandedEvents(prev => {
        const cur = prev[item.invokeId]
        if (cur == null) return prev
        if (cur.some(e => e.id === ev.id)) return prev
        if (cur.length > 0 && ev.sequenceNum <= cur[cur.length - 1]!.sequenceNum) return prev
        return { ...prev, [item.invokeId]: [...cur, ev] }
      })
    }
    const listeners = liveListeners.current
    listeners.add(listener)
    /** 回放积压（弹窗打开前 buffer 里的本獭事件） */
    for (const item of [...liveEvents.current]) listener(item)
    return () => { listeners.delete(listener) }
  }, [otter.id, liveEvents, liveListeners, refreshEvents, refreshInvokes])

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
          {/* SSE 断连兜底——不静默装实时 */}
          {connLost && (
            <div className="mb-2 px-3 py-1.5 rounded-lg border border-caramel-400/40 text-[10px] text-caramel-600 bg-caramel-400/10" data-testid="conn-lost-banner">
              实时连接断开，自动重连中…（已显示的内容不受影响）
            </div>
          )}
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
            const isRunning = (liveStatus[inv.id] ?? inv.status) === 'running'
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
                    {/* 折叠视图（invoke-event-fold 归并）+ 展开区全文（F20260914evdz：
                        找回旧版形态——参数/结果全文 + 复制，替换 #916 原始 JSON 截断分列）。
                        存储忠实保留原始流——折叠仅渲染层，rawEventIds 溯源 */}
                    {!loading && (expandedEvents[inv.id] ?? []).length > TERMINAL_EVENTS_LIMIT && !isRunning && (
                      <div className="py-1 text-[10px] text-stone-400">事件较多，仅展示最近 {TERMINAL_EVENTS_LIMIT} 条（上翻分页见后续迭代）</div>
                    )}
                    {!loading && foldInvokeEvents(visibleEvents(expandedEvents[inv.id] ?? [], isRunning), { invokeEnded: !isRunning }).map((step, idx) => (
                      <FoldedStepItem
                        key={`${inv.id}:${idx}`}
                        step={step}
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
                        实时观察中（事件驱动）· 上滚暂停，回底恢复
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

/** 终态 invoke 事件量兜底：running 全量（实时通道需要完整集）；终态截最近 N 条 */
function visibleEvents(events: InvokeEventDTO[], isRunning: boolean): InvokeEventDTO[] {
  if (isRunning || events.length <= TERMINAL_EVENTS_LIMIT) return events
  return events.slice(-TERMINAL_EVENTS_LIMIT)
}

/** 折叠步渲染（点击展开全文区——参数/结果/发言/思考，带复制按钮） */
function FoldedStepItem({ step, rawExpanded, onToggleRaw }: {
  step: FoldedStep
  rawExpanded: boolean
  onToggleRaw: () => void
}) {
  if (step.kind === 'call') {
    const statusDot = step.interrupted
      ? <span className="w-1.5 h-1.5 rounded-full bg-stone-400 flex-shrink-0 mt-1" title="已中断（invoke 终态时未收到结果）" />
      : step.pending
        ? <span className="w-1.5 h-1.5 rounded-full bg-caramel-400 animate-pulse flex-shrink-0 mt-1" title="执行中" />
        : step.isError
          ? <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0 mt-1" title="失败" />
          : <span className="w-1.5 h-1.5 rounded-full bg-teal-400 flex-shrink-0 mt-1" title="成功" />
    return (
      <div className="py-1 border-b border-white/20 last:border-0" data-testid="folded-call-step">
        <div
          className="flex gap-2 items-start cursor-pointer hover:bg-white/20 rounded-lg px-1 -mx-1 transition"
          onClick={onToggleRaw}
        >
          {statusDot}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <Wrench className="w-3 h-3 text-amber-500 flex-shrink-0" />
              <span className="text-[10px] font-medium text-stone-600">{step.name}</span>
              <span className="text-[9px] text-stone-400 truncate max-w-[280px]">{callArgsSummary(step.args)}</span>
              {step.interrupted
                ? <span className="text-[9px] text-stone-400">已中断</span>
                : step.pending
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
          <div className="ml-4 mt-1 pl-2 border-l-2 border-white/40 space-y-1.5" data-testid="step-full-text">
            {step.args != null && (
              <FullTextBlock label="参数" text={fullText(step.args)} testid="args-full" />
            )}
            {step.result != null ? (
              <FullTextBlock label={`结果${step.isError ? ' · 失败' : ''}`} text={fullText(step.result)} testid="result-full" />
            ) : step.interrupted ? (
              <FullTextBlock label="结果" text="（已中断——invoke 终态时未收到结果）" testid="result-full" />
            ) : (
              <div className="text-[9px] text-caramel-500">执行中，暂无结果…</div>
            )}
          </div>
        )}
      </div>
    )
  }
  if (step.kind === 'think') {
    return (
      <div className="py-1 border-b border-white/20 last:border-0">
        <div
          className="flex gap-2 items-start cursor-pointer hover:bg-white/20 rounded-lg px-1 -mx-1 transition"
          onClick={onToggleRaw}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-stone-400 flex-shrink-0 mt-1" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <Braces className="w-3 h-3 text-stone-400 flex-shrink-0 mt-0.5" />
              <span className="text-[10px] font-medium text-stone-500 italic">思考</span>
              <span className="text-[9px] text-stone-400">{fmtTime(step.ts)}</span>
            </div>
            <div className="text-[10px] text-stone-500 italic whitespace-pre-wrap break-all leading-relaxed mt-0.5 line-clamp-6" title={step.text}>{step.text}</div>
          </div>
          <ChevronRight className={`w-3 h-3 text-stone-300 flex-shrink-0 mt-1 transition-transform ${rawExpanded ? 'rotate-90' : ''}`} />
        </div>
        {rawExpanded && (
          <div className="ml-4 mt-1 pl-2 border-l-2 border-white/40" data-testid="step-full-text">
            <FullTextBlock label="思考全文" text={step.text} testid="think-full" />
          </div>
        )}
      </div>
    )
  }
  if (step.kind === 'speak') {
    return (
      <div className="py-1 border-b border-white/20 last:border-0 rounded-lg" style={{ background: 'rgba(180,131,106,0.08)' }}>
        <div
          className="flex gap-2 items-start cursor-pointer hover:bg-white/20 rounded-lg px-1 -mx-1 transition"
          onClick={onToggleRaw}
        >
          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1" style={{ background: 'var(--otter-600)' }} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <MessageSquare className="w-3 h-3 text-otter-400 flex-shrink-0 mt-0.5" />
              <span className="text-[10px] font-medium text-otter-600">发言</span>
              <span className="text-[9px] text-stone-400">{fmtTime(step.ts)}</span>
            </div>
            <div className="text-[10px] text-stone-600 whitespace-pre-wrap break-all leading-relaxed mt-0.5 line-clamp-6" title={step.body}>{step.body}</div>
          </div>
          <ChevronRight className={`w-3 h-3 text-stone-300 flex-shrink-0 mt-1 transition-transform ${rawExpanded ? 'rotate-90' : ''}`} />
        </div>
        {rawExpanded && (
          <div className="ml-4 mt-1 pl-2 border-l-2 border-white/40" data-testid="step-full-text">
            <FullTextBlock label="发言全文" text={step.body} testid="speak-full" />
          </div>
        )}
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

/** 全文块（旧版「流式过程」面板形态找回——label + 复制按钮 + 可滚动全文） */
function FullTextBlock({ label, text, testid }: { label: string; text: string; testid?: string }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="text-[9px] font-medium text-stone-500">{label}</span>
        <CopyButton text={text} />
      </div>
      <div
        data-testid={testid}
        className="text-[10px] text-stone-500 bg-stone-50/60 rounded-lg px-2.5 py-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-all leading-relaxed"
      >
        {text}
      </div>
    </div>
  )
}

/** 复制按钮（复刻旧版 MessageList CopyButton——SessionModal 内自持，避免动大文件） */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard API 不可用时静默忽略 */ }
  }
  return (
    <button
      onClick={handleCopy}
      className="p-1 rounded hover:bg-stone-200/60 transition text-stone-400 hover:text-stone-600"
      title="复制"
      aria-label="复制"
    >
      {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
    </button>
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

/** 展开区全文：SDK 结果 content 块拼接；否则 JSON 美化（防御性） */
function fullText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && Array.isArray((v as { content?: unknown }).content)) {
    const texts = ((v as { content: Array<{ text?: string }> }).content ?? [])
      .map(c => (typeof c?.text === 'string' ? c.text : ''))
      .filter(Boolean)
    if (texts.length > 0) return texts.join('\n')
  }
  try { return JSON.stringify(v, null, 2) ?? '' } catch { return String(v) }
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
