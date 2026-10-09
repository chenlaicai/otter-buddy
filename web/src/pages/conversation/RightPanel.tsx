import { useState, useRef, useCallback, useEffect, memo } from 'react'
import { createPortal } from 'react-dom'
import { Plus, X, RotateCcw, Check, Users, Folder, Timer, Activity, Square, ClipboardList } from 'lucide-react'
import { OTTER_GRADIENT } from '../../lib/otter-colors'
import type { LocalConversation as Conversation, LocalOtter as Otter, LocalOtterSession as OtterSession, LocalScheduledTask } from '../../lib/mappers'
import { sortSessionChain } from '../../lib/session-chain'
import { OtterAvatar } from '../../components/OtterAvatar'
import { OtterProfileCard } from '../../components/OtterProfileCard'
import { fmtTime } from '../../lib/utils'
import { ScheduledTaskSection } from './ScheduledTaskSection'
import { WorkspacePanel } from './WorkspacePanel'
import { MattersPanel } from './MattersPanel'
import { fmtInvokeElapsed, fmtCtx, type OtterInvokeState } from '../../lib/invoke-tracker'

interface RightPanelProps {
  conversation: Conversation
  otters: Otter[]
  sessions: Record<string, OtterSession[]>
  /** F20260913ctlv：獭 invoke 实时状态（streaming/休眠 + 当前 invoke 统计） */
  invokeStates?: import('../../lib/invoke-tracker').InvokeStates
  /** F20260913ctlv：点击獭头像 → Session 弹窗（invoke 历史 + 流式过程） */
  onOpenSession?: (otterId: string) => void
  /** F20260913ctlv：中断獭当前 running invoke（右栏按钮；POST /api/invokes/:id/abort） */
  onAbortInvoke?: (otterId: string, invokeId: string) => void
  /** F20260913ctlv：重试失败/中断 invoke（右栏按钮；POST /api/invokes/:id/retry） */
  onRetryInvoke?: (otterId: string) => void
  /** F20261009csf3：linkedResources/onAddFact/onToggleResourceFlag/onAddLinkedResource/onDeleteLinkedResource
   *  随关键资源 tab 退役——产物展示走中间栏时间轴（ChatView 的 linkedResources prop），
   *  管理（登记/标旗/删除）走对话通道（create_linked_resource 等工具） */
  onCreateSmallOtter: () => void
  onDissolveOtter: (otterId: string) => void
  onRestartOtter: (otterId: string) => void
  onOpenOtterDetail: (otterId: string) => void
  // 定时任务 props
  scheduledTasks: LocalScheduledTask[]
  scheduledTasksLoading: boolean
  onToggleScheduledTask: (taskId: string) => void
  onCreateScheduledTask: () => void
  onEditScheduledTask: (task: LocalScheduledTask) => void
  onDeleteScheduledTask: (taskId: string) => void
  onTriggerScheduledTask: (taskId: string) => void
  onViewScheduledTaskHistory: (taskId: string) => void
  /** F20261006mlp2 P2：待办板裁决回执路由（handleSend 的 mention 路由封装——owner 为空时默认派发） */
  onRouteToOtter?: (body: string, ownerOtterId: string | null) => void
}

/** 右侧栏 tab 类型（F20261009csf3：resources/关键资源 tab 已退役——产物改由中间栏时间轴混排展示
 *  （F20261008csf1 摘要卡 + F20261009csp2 活类登记），手动登记/标旗/删除走对话通道，
 *  搭档拍板方案 A「彻底退役，平时主要海獭间用」） */
type RightPanelTab = 'participants' | 'tasks' | 'workspace' | 'matters'

export function RightPanel(props: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<RightPanelTab>('participants')
  /** F20260914rtsp：走秒驱动——有任一 running 时 1s interval 重渲染右栏（无 running 停，AT-3）。
 *  Why 容器级单定时器：N 獭 N 定时器无意义；现状仅靠对话列表轮询（5s）间接 re-render 搭便车，
 *  页面隐藏即完全定格（F20260805actv 副作用，见 F20260914rtsp P1） */
  const [tickNow, setTickNow] = useState(() => Date.now())
  const anyRunning = Object.values(props.invokeStates ?? {}).some(s => s.status === 'running')
  useEffect(() => {
    if (!anyRunning) return
    const t = setInterval(() => setTickNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [anyRunning])

  /** tab 配置（F20261009csf3：resources tab 移除） */
  const tabs: Array<{ id: RightPanelTab; icon: React.ReactNode; label: string }> = [
    { id: 'participants', icon: <Users className="w-4 h-4" />, label: '参与者' },
    { id: 'tasks', icon: <Timer className="w-4 h-4" />, label: '定时任务' },
    { id: 'workspace', icon: <Folder className="w-4 h-4" />, label: '工作区' },
    { id: 'matters', icon: <ClipboardList className="w-4 h-4" />, label: '待办' },
  ]

  return (
    <aside className="w-64 h-full glass rounded-3xl flex flex-col overflow-hidden flex-shrink-0">
      {/* Tab 切换条 */}
      <div className="flex border-b border-white/40">
        {tabs.map(tab => (
          <button
            key={tab.id}
            data-testid={`tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition ${
              activeTab === tab.id
                ? 'text-otter-600 border-b-2 border-otter-500'
                : 'text-stone-400 hover:text-stone-600'
            }`}
            title={tab.label}
          >
            {tab.icon}
            <span className="hidden sm:inline">{tab.label}</span>
          </button>
        ))}
      </div>

      {/* 内容区：根据激活的 tab 渲染 */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'participants' && (
          <div className="p-4">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 mb-2">Otter 参与者</h3>
            <div>
              {props.otters.map(o => (
                <OtterParticipantCard
                  key={o.id}
                  otter={o}
                  sessions={props.sessions[o.id] || []}
                  invokeState={props.invokeStates?.[o.id]}
                  tickNow={tickNow}
                  onClick={() => props.onOpenOtterDetail(o.id)}
                  onOpenSession={props.onOpenSession ? () => props.onOpenSession?.(o.id) : undefined}
                  onAbortInvoke={props.onAbortInvoke ? (invokeId) => props.onAbortInvoke?.(o.id, invokeId) : undefined}
                  onRetryInvoke={props.onRetryInvoke ? () => props.onRetryInvoke?.(o.id) : undefined}
                  onDissolve={props.onDissolveOtter}
                  onRestart={props.onRestartOtter}
                />
              ))}
              <button
                onClick={props.onCreateSmallOtter}
                className="w-full mt-1.5 py-1.5 text-xs glass-card text-stone-500 rounded-xl hover:bg-white/40 hover:text-otter-500 transition flex items-center justify-center gap-1"
              >
                <Plus className="w-3 h-3" /> 创建小獭
              </button>
            </div>
          </div>
        )}

        {activeTab === 'tasks' && (
          <div className="p-4">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 mb-2 flex justify-between items-center">
              <span className="flex items-center gap-1">
                <Timer size={12} />
                定时任务
              </span>
              <button
                onClick={props.onCreateScheduledTask}
                className="text-stone-400 hover:text-otter-500 w-5 h-5 flex items-center justify-center rounded"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </h3>
            {props.scheduledTasksLoading ? (
              <div className="space-y-2">
                <div className="h-16 bg-white/20 rounded-xl animate-pulse" />
                <div className="h-16 bg-white/20 rounded-xl animate-pulse" />
              </div>
            ) : (
              <ScheduledTaskSection
                tasks={props.scheduledTasks}
                onToggle={props.onToggleScheduledTask}
                onEdit={props.onEditScheduledTask}
                onDelete={props.onDeleteScheduledTask}
                onTrigger={props.onTriggerScheduledTask}
                onViewHistory={props.onViewScheduledTaskHistory}
              />
            )}
          </div>
        )}

        {activeTab === 'workspace' && (
          <WorkspacePanel conversationId={props.conversation.id} />
        )}

        {activeTab === 'matters' && (
          <MattersPanel conversationId={props.conversation.id} onRouteToOtter={props.onRouteToOtter} />
        )}
      </div>
    </aside>
  )
}

/** 触屏设备检测（惰性求值，避免 jsdom 测试环境崩溃） */
let _isTouchDevice: boolean | undefined
function isTouchDevice() {
  if (_isTouchDevice === undefined) {
    _isTouchDevice = typeof window !== 'undefined' && !!window.matchMedia?.('(hover: none)').matches
  }
  return _isTouchDevice
}

/**
 * #502：memo 兜底——allOtters 浅比较保住引用后，本组件 props 稳定即不重渲染，
 * hover 快览卡不再因轮询产生的新对象引用而微闪。
 * onClick/onDissolve/onRestart 由 RightPanel 内联箭头每次新建——memo 对函数 props 无效，
 * 但 otter/sessions 两个数据 props 是抖动主源，仍值得包。
 */
const OtterParticipantCard = memo(function OtterParticipantCard({
  otter: o,
  sessions,
  invokeState,
  tickNow,
  onClick,
  onOpenSession,
  onAbortInvoke,
  onRetryInvoke,
  onDissolve,
  onRestart,
}: {
  otter: Otter
  sessions: OtterSession[]
  /** F20260913ctlv：invoke 实时状态（undefined = 本会话无 invoke，显示休眠） */
  invokeState?: OtterInvokeState
  /** F20260914rtsp：右栏容器级走秒时钟——驱动 fmtInvokeElapsed 重算（running 状态行每秒 +1s）。
 *  仅作重渲染触发器，卡片内不直接消费其值（耗时函数用默认 Date.now()） */
  tickNow?: number
  onClick: () => void
  /** F20260913ctlv：点击头像 → Session 弹窗 */
  onOpenSession?: () => void
  /** F20260913ctlv：中断当前 running invoke（右栏按钮） */
  onAbortInvoke?: (invokeId: string) => void
  /** F20260913ctlv：重试失败/中断 invoke（右栏按钮） */
  onRetryInvoke?: () => void
  onDissolve: (id: string) => void
  onRestart: (id: string) => void
}) {
  /** F20260920uhuc：忙碌判定——running invoke 存在即置灰重启 */
  const invokeStateBusy = invokeState?.status === 'running'
  const isBig = o.type === 'big'
  const activeS = sessions.find(s => s.status === 'active')
  /** F20260805dmux：世数与详情弹窗同口径（拉链位置），不用 sessions.length */
  const activeGen = activeS ? sortSessionChain(sessions).indexOf(activeS) + 1 : 0
  const [hovering, setHovering] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** F20260826pfix：trigger rect 快照，hover 展开时供 portal 定位 */
  const rowRef = useRef<HTMLDivElement>(null)
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null)

  // Why: 400ms 延迟 + useRef 手写 debounce —— 快速滑过不触发，停留才弹出；
  // 弹出前抓取 row rect 快照供 portal 定位
  const handleMouseEnter = useCallback(() => {
    if (isTouchDevice()) return
    hoverTimer.current = setTimeout(() => {
      if (rowRef.current) setTriggerRect(rowRef.current.getBoundingClientRect())
      setHovering(true)
    }, 400)
  }, [])
  const handleMouseLeave = useCallback(() => {
    clearTimeout(hoverTimer.current)
    setHovering(false)
  }, [])

  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  return (
    <div
      ref={rowRef}
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        onClick={onClick}
        className="px-2.5 py-2 rounded-xl cursor-pointer glass-card mb-1.5 transition hover:shadow-bubble hover:-translate-y-0.5 group"
      >
        {/* F20260913ctlv test17 排版：主行只放身份信息（头像+名/模型+类型/世数+状态行），
            操作按钮独立一行（Session / 中断 / 重试 + hover 管理动作）——不再全挤一行 */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={e => { e.stopPropagation(); if (onOpenSession) onOpenSession() }}
            className="relative flex-shrink-0 rounded-full"
            aria-label={`查看 ${o.name} 的 session 记录`}
          >
            <OtterAvatar otterId={o.id} name={o.name} size={32} type={o.type} />
            {/* F20260913ctlv：streaming 呼吸点（活跃 invoke 指示，叠加在头像右下角） */}
            {invokeState?.status === 'running' && (
              <span className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full bg-teal-400 border border-white animate-pulse" data-testid="invoke-streaming-dot" />
            )}
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs font-semibold text-stone-700 truncate">{o.name}</span>
              {/* F20260908efmd: 模型 badge（配置缺失回退默认恒非空） */}
              {o.modelAlias && (
                <span data-testid="model-badge" className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-stone-400/15 text-stone-500 whitespace-nowrap shrink-0">
                  {o.modelAlias}{o.modelIsDefault && <span className="text-stone-400">（默认）</span>}
                </span>
              )}
            </div>
            <div className="text-[10px] text-stone-400 whitespace-nowrap truncate">
              {/* F20260914rtsp：世数时间改「from」格式（搭档拍板）；大獭必然在场，「大獭 · 持久」前缀移除 */}
              {isBig ? '' : (o.role?.name || '小獭')}{activeS ? ` · 第${activeGen}世 from ${fmtTime(activeS.startedAt)}` : ''}
            </div>
            {/* F20260914rtsp：invoke 实时状态行（行动中：状态+走秒+工具数+ctx；休息中：ctx 兜底）。
 *  走秒由容器 tickNow 驱动重渲染；ctx 缺数据时显 '—'（tick 未发射过/刷新无 ctx_tokens）。
 *  无 invoke 记录但有世时也显示休息中行——ctx 表示「当前 session 上下文占用」，休息中占用不变，
 *  属准确数据；从未握过（新建无数据）则显 '—'。 */}
            {(invokeState || activeS) && (
              <div className="text-[9px] whitespace-nowrap truncate" data-testid="invoke-state-line">
                {invokeState?.status === 'running' ? (
                  <span className="text-teal-500">● 行动中 · {fmtInvokeElapsed(invokeState, tickNow)} · 🛠 {invokeState.toolCallCount ?? '—'} · {fmtCtx(invokeState.ctxWindowUsed)}/{invokeState.ctxMax != null ? fmtCtx(invokeState.ctxMax) : '—'}</span>
                ) : (
                  <span className="text-stone-400">○ 休息中 · {fmtCtx(invokeState?.ctxWindowUsed)}/{invokeState?.ctxMax != null ? fmtCtx(invokeState.ctxMax) : '—'}</span>
                )}
              </div>
            )}
          </div>
        </div>
        {/* 操作行：Session 入口（占满余宽）+ invoke 控制（running=中断 / 终态失败=重试）+ hover 管理动作 */}
        <div className="flex items-center gap-1 mt-1.5 pt-1.5 border-t border-white/30">
          {onOpenSession && (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onOpenSession() }}
              className="flex-1 h-6 rounded-lg text-[10px] text-stone-500 hover:text-otter-500 hover:bg-white/40 transition flex items-center justify-center gap-1"
              aria-label={`查看 ${o.name} 的流式过程`}
              title="Session：invoke 历史 + 流式过程"
              data-testid="invoke-stream-button"
            >
              <Activity className="w-3 h-3" />
              Session
            </button>
          )}
          {invokeState?.status === 'running' && invokeState.invokeId && onAbortInvoke && (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onAbortInvoke(invokeState.invokeId) }}
              className="h-6 px-2 rounded-lg text-[10px] text-red-400 hover:bg-red-400/10 transition flex items-center gap-1 flex-shrink-0"
              title="中断：停止该獭当前行动（已产出内容保留，可重试）"
              data-testid="invoke-abort-button"
            >
              <Square className="w-2.5 h-2.5 fill-current" />
              中断
            </button>
          )}
          {(invokeState?.status === 'failed' || invokeState?.status === 'aborted') && onRetryInvoke && (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onRetryInvoke() }}
              className="h-6 px-2 rounded-lg text-[10px] text-otter-500 hover:bg-otter-400/10 transition flex items-center gap-1 flex-shrink-0"
              title="重试：重新执行该獭的上次行动（session 上下文保留，新 invoke 接续跑）"
              data-testid="invoke-retry-button"
            >
              <RotateCcw className="w-2.5 h-2.5" />
              重试
            </button>
          )}
          {!isBig && (
            <span
              onClick={e => { e.stopPropagation(); onDissolve(o.id) }}
              className="opacity-0 group-hover:opacity-100 h-6 px-1.5 rounded-lg text-[10px] text-stone-400 hover:text-red-400 cursor-pointer flex items-center transition"
              title="解散该小獭（不可逆）"
            >
              解散
            </span>
          )}
          {/* F20260920srbtn：重启獭生对小獭开放（与 agent 侧 restart_otter 大獭可重启小獭对齐）；
              F20260920uhuc：忙碌置灰（running invoke 时禁用） */}
          <button
            onClick={e => { e.stopPropagation(); if (!invokeStateBusy) onRestart(o.id) }}
            disabled={invokeStateBusy}
            className={`h-6 px-1.5 rounded-lg text-[10px] transition flex items-center ${invokeStateBusy ? 'text-stone-300 cursor-not-allowed opacity-60' : 'opacity-0 group-hover:opacity-100 text-stone-400 hover:text-red-400'}`}
            title={invokeStateBusy ? '忙碌中，不允许重启（等当前行动结束）' : '重启獭生（封存当前 session，开启新一世）'}
          >
            重启
          </button>
        </div>
      </div>
      {/* hover 快览卡：F20260826pfix 改 Portal + fixed 按 trigger 坐标定位。
       *  Why: 原 absolute right-full bottom-0 在 aside overflow-y-auto 内，列表长时
       *  （卡片滚到 panel 底部）快览卡向上延伸被 panel 顶缘剪裁/视觉贴屏顶。
       *  Portal 脱离 aside 的 overflow 上下文，坐标按 trigger rect 实时计算并 clamp。 */}
      {hovering && triggerRect && createPortal(
        <div
          className="fixed z-50"
          style={{
            left: Math.max(8, Math.min(triggerRect.left - 292, window.innerWidth - 300)),
            top: Math.min(triggerRect.top, window.innerHeight - 220),
          }}
        >
          <OtterProfileCard otter={o} sessions={sessions} modelAlias={o.modelAlias} />
        </div>,
        document.body,
      )}
    </div>
  )
})

