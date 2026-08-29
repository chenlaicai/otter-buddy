import { useState, useRef, useCallback, useEffect, memo } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Star, X, MoreHorizontal, RotateCcw, Check, Copy, Users, Folder, FileText, Timer } from 'lucide-react'
import { OTTER_GRADIENT } from '../../lib/otter-colors'
import type { LocalConversation as Conversation, LocalOtter as Otter, LocalLinkedResource as LinkedResource, LocalOtterSession as OtterSession, LocalScheduledTask } from '../../lib/mappers'
import { sortSessionChain } from '../../lib/session-chain'
import { OtterAvatar } from '../../components/OtterAvatar'
import { OtterProfileCard } from '../../components/OtterProfileCard'
import { ScheduledTaskSection } from './ScheduledTaskSection'
import { WorkspacePanel } from './WorkspacePanel'

interface RightPanelProps {
  conversation: Conversation
  otters: Otter[]
  sessions: Record<string, OtterSession[]>
  linkedResources: LinkedResource[]
  onCreateSmallOtter: () => void
  onDissolveOtter: (otterId: string) => void
  onRestartOtter: (otterId: string) => void
  onOpenOtterDetail: (otterId: string) => void
  onAddFact: (content: string, category: string) => void
  onToggleResourceFlag: (id: string) => void
  onAddLinkedResource: () => void
  onDeleteLinkedResource: (id: string) => void
  // 定时任务 props
  scheduledTasks: LocalScheduledTask[]
  scheduledTasksLoading: boolean
  onToggleScheduledTask: (taskId: string) => void
  onCreateScheduledTask: () => void
  onEditScheduledTask: (task: LocalScheduledTask) => void
  onDeleteScheduledTask: (taskId: string) => void
  onTriggerScheduledTask: (taskId: string) => void
  onViewScheduledTaskHistory: (taskId: string) => void
}

/** 右侧栏 tab 类型 */
type RightPanelTab = 'participants' | 'resources' | 'tasks' | 'workspace'

export function RightPanel(props: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<RightPanelTab>('participants')
  const [showKfForm, setShowKfForm] = useState(false)
  const [kfContent, setKfContent] = useState('')
  const [kfCategory, setKfCategory] = useState('')

  function handleAddFact() {
    if (!kfContent.trim()) return
    props.onAddFact(kfContent, kfCategory)
    setKfContent('')
    setKfCategory('')
    setShowKfForm(false)
  }

  /** 选择「链接」类型时关闭内联表单、打开链接弹窗（复用现有 modal 流程） */
  function handlePickLink() {
    setShowKfForm(false)
    props.onAddLinkedResource()
  }

  /** tab 配置 */
  const tabs: Array<{ id: RightPanelTab; icon: React.ReactNode; label: string }> = [
    { id: 'participants', icon: <Users className="w-4 h-4" />, label: '参与者' },
    { id: 'resources', icon: <FileText className="w-4 h-4" />, label: '关键资源' },
    { id: 'tasks', icon: <Timer className="w-4 h-4" />, label: '定时任务' },
    { id: 'workspace', icon: <Folder className="w-4 h-4" />, label: '工作区' },
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
                  onClick={() => props.onOpenOtterDetail(o.id)}
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

        {activeTab === 'resources' && (
          <div className="p-4">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 mb-2 flex justify-between items-center">
              关键资源
              <button
                onClick={() => setShowKfForm(!showKfForm)}
                className="text-stone-400 hover:text-otter-500 w-5 h-5 flex items-center justify-center rounded"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </h3>
            {showKfForm && (
              <div className="glass-card rounded-xl p-2.5 mb-2 flex flex-col gap-1.5">
                <input
                  value={kfContent}
                  onChange={e => setKfContent(e.target.value)}
                  placeholder="事实内容"
                  className="form-input text-xs"
                />
                <input
                  value={kfCategory}
                  onChange={e => setKfCategory(e.target.value)}
                  placeholder="分类 (可选)"
                  className="form-input text-xs"
                />
                <div className="flex gap-1.5 justify-end">
                  <button onClick={handlePickLink} className="px-2.5 py-1 text-xs text-teal-500">改为添加链接…</button>
                  <button onClick={() => setShowKfForm(false)} className="px-2.5 py-1 text-xs text-stone-500">取消</button>
                  <button
                    onClick={handleAddFact}
                    className="px-2.5 py-1 text-xs text-white rounded-lg"
                    style={{ background: OTTER_GRADIENT }}
                  >
                    添加事实
                  </button>
                </div>
              </div>
            )}
            <div>
              {props.linkedResources.length === 0 && (
                <div className="text-[11px] text-stone-400 px-1.5 py-1">暂无关键资源</div>
              )}
              {props.linkedResources.map(r => (
                r.type === 'fact'
                  ? <FactItem key={r.id} fact={r} onToggleFlag={() => props.onToggleResourceFlag(r.id)} onDelete={() => props.onDeleteLinkedResource(r.id)} />
                  : <LinkedResourceItem key={r.id} resource={r} onDelete={() => props.onDeleteLinkedResource(r.id)} />
              ))}
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

/** F20260827rsux：资源详情悬浮卡——取代原生 title tooltip。
 *  Why: ①条目截断后 value 只能悬停看原生灰条，无样式且超长不换行不可复制；
 *  ②快速复制是硬需求（PR 号、路径、事实文本都是要贴到别处用的）。
 *  How: Portal + fixed 定位摆脱 aside overflow-y-auto 剪裁（F20260826pfix 同模式）。
 *  卡内文本 wrap 不截断可选中；右上角一键复制（clipboard API + execCommand 降级）。
 *  copyText 显式传入要复制的纯文本（检视发现 2：fact 卡的 category 徽章是展示元数据，
 *  不得混入剪贴板——innerText 方案对链接类碰巧对，对 fact 类是噪音，改为调用方声明式传入）。 */
function ResourceHoverCard({ x, y, copyText, children }: { x: number; y: number; copyText: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const copy = () => {
    // 优先 copyText；防御性回退 innerText（调用方未传时兜底，不应对外暴露）
    const t = copyText || bodyRef.current?.innerText || ''
    if (!t) return
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500) }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(t).then(done).catch(() => { if (legacyCopy(t)) done() })
    } else if (legacyCopy(t)) done()
  }
  return createPortal(
    <div
      className="fixed z-50"
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - 296)), top: Math.min(y, window.innerHeight - 160) }}
    >
      <div className="relative glass-strong rounded-2xl p-3 w-[280px] shadow-bubble">
        <button
          onClick={copy}
          title="复制全文"
          className="absolute top-2 right-2 p-1 rounded-md text-stone-400 hover:text-otter-500 hover:bg-white/40 transition"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-teal-500" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
        <div ref={bodyRef} className="text-xs text-stone-600 leading-relaxed break-all whitespace-pre-wrap pr-6 select-text">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** 非安全上下文（局域网 IP 访问 dev server 等）无 clipboard API 时的降级复制。
 *  F20260827rsux：与 Modals.tsx 同实现（该处为未导出的私有函数，这里内联一份，待后续统一提取） */
function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { /* 降级也失败则静默，hover 卡仍展示全文 */ }
  document.body.removeChild(ta)
  return ok
}

/** F20260827rsux：资源条目 hover 态（400ms debounce + rect 快照，与 OtterParticipantCard 快览卡同节奏） */
function useResourceHover() {
  const [hovering, setHovering] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const onEnter = useCallback(() => {
    if (isTouchDevice()) return
    timer.current = setTimeout(() => {
      if (rowRef.current) setRect(rowRef.current.getBoundingClientRect())
      setHovering(true)
    }, 400)
  }, [])
  const onLeave = useCallback(() => {
    clearTimeout(timer.current)
    setHovering(false)
  }, [])
  useEffect(() => () => clearTimeout(timer.current), [])
  return { rowRef, hovering, rect, onEnter, onLeave }
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
  onClick,
  onDissolve,
  onRestart,
}: {
  otter: Otter
  sessions: OtterSession[]
  onClick: () => void
  onDissolve: (id: string) => void
  onRestart: (id: string) => void
}) {
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
        className="flex items-center gap-2 px-2.5 py-2 rounded-xl cursor-pointer glass-card mb-1.5 transition hover:shadow-bubble hover:-translate-y-0.5 group"
      >
        <OtterAvatar otterId={o.id} name={o.name} size={28} type={o.type} />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-stone-700">{o.name}</div>
          <div className="text-[10px] text-stone-400">{isBig ? '大獭 · 持久' : (o.role?.name || '')}</div>
          {activeS && (
            <div className="text-[9px] text-stone-400">
              第{activeGen}世 · {activeS.startedAt.split(' ')[1] || activeS.startedAt}
            </div>
          )}
        </div>
        {/* 模型标签（F20260825vrqh）：未配置不渲染，与「大獭」badge 同行同视觉权重。
            F20260826 身份证重构曾把它挤出卡片外（mt-1 w-fit 挂在玻璃卡下方缝隙里视觉隐形），本 PR 挪回原位 */}
        {o.modelAlias && (
          <span data-testid="model-badge" className="text-[9px] font-semibold px-2 py-0.5 rounded-full bg-stone-400/15 text-stone-500">{o.modelAlias}</span>
        )}
        {isBig ? (
          <span className="text-[9px] font-semibold px-2 py-0.5 rounded-full bg-otter-400/15 text-otter-500">大獭</span>
        ) : (
          <span
            onClick={e => { e.stopPropagation(); onDissolve(o.id) }}
            className="opacity-0 group-hover:opacity-100 text-stone-400 cursor-pointer"
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </span>
        )}
        {/* F20260805rsto：重启是大獭专属（小獭用解散），与详情弹窗 footer 对齐 */}
        {isBig && (
          <button
            onClick={e => { e.stopPropagation(); onRestart(o.id) }}
            className="opacity-0 group-hover:opacity-100 text-[10px] text-red-400 px-1.5 py-0.5 rounded hover:bg-red-400/10 transition flex items-center gap-0.5"
          >
            <RotateCcw className="w-2.5 h-2.5" />
            重启
          </button>
        )}
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

function FactItem({ fact: f, onToggleFlag, onDelete }: { fact: LinkedResource; onToggleFlag: () => void; onDelete: () => void }) {
  const h = useResourceHover()
  return (
    <div
      ref={h.rowRef}
      onMouseEnter={h.onEnter}
      onMouseLeave={h.onLeave}
      className="flex items-start gap-1.5 px-1.5 py-1 rounded-lg hover:bg-white/30 transition group"
    >
      <span
        onClick={onToggleFlag}
        className={`cursor-pointer mt-0.5 ${f.flagged ? 'text-amber-400' : 'text-stone-300'}`}
      >
        <Star className="w-3.5 h-3.5" fill={f.flagged ? 'currentColor' : 'none'} />
      </span>
      <span className="text-xs text-stone-600 flex-1 min-w-0 flex flex-col gap-1">
        {/* F20260827rsux：原生 title tooltip 升级为悬浮详情卡（全文 + 一键复制） */}
        <span className="truncate">{f.content}</span>
        {f.category && (
          <span className="text-[9px] text-stone-400 bg-white/30 px-1.5 py-0.5 rounded-full w-fit">
            {f.category}
          </span>
        )}
      </span>
      <span
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 text-red-400 mt-0.5 cursor-pointer"
      >
        <X className="w-3 h-3" />
      </span>
      {h.hovering && h.rect && (
        <ResourceHoverCard x={h.rect.left} y={h.rect.bottom + 4} copyText={f.content ?? ''}>
          {f.category && <span className="inline-block text-[9px] text-stone-400 bg-white/40 px-1.5 py-0.5 rounded-full mr-1">{f.category}</span>}
          {f.content}
        </ResourceHoverCard>
      )}
    </div>
  )
}

function LinkedResourceItem({ resource: r, onDelete }: { resource: LinkedResource; onDelete: () => void }) {
  const h = useResourceHover()
  return (
    <div
      ref={h.rowRef}
      onMouseEnter={h.onEnter}
      onMouseLeave={h.onLeave}
      className="flex items-center gap-1.5 px-1.5 py-1 rounded-lg hover:bg-white/30 transition group"
    >
      {/* 与 FactItem 统一为 stone 色系：链接类资源加类型色块，长标题截断（F20260827rsux：详情看悬浮卡） */}
      <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-skeleton text-stone-500 uppercase flex-shrink-0">{r.type}</span>
      <span className="text-xs text-stone-600 truncate flex-1">
        {r.title || r.url || '(无标题)'}
      </span>
      {r.auto && (
        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-teal-400/15 text-teal-500 flex-shrink-0">自动</span>
      )}
      <span
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 text-red-400 cursor-pointer"
      >
        <X className="w-3 h-3" />
      </span>
      {h.hovering && h.rect && (
        <ResourceHoverCard x={h.rect.left} y={h.rect.bottom + 4} copyText={[r.title, r.url].filter(Boolean).join('\n')}>
          {r.title && <span className="block font-semibold text-stone-700 mb-1">{r.title}</span>}
          {r.url && <span className="block text-teal-600 break-all">{r.url}</span>}
          {!r.title && !r.url && <span className="text-stone-400">(无内容)</span>}
        </ResourceHoverCard>
      )}
    </div>
  )
}
