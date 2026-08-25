import { useState } from 'react'
import { Plus, Star, X, MoreHorizontal, RotateCcw, Clock } from 'lucide-react'
import { OTTER_GRADIENT } from '../../lib/otter-colors'
import type { LocalConversation as Conversation, LocalOtter as Otter, LocalLinkedResource as LinkedResource, LocalOtterSession as OtterSession, LocalScheduledTask } from '../../lib/mappers'
import { sortSessionChain } from '../../lib/session-chain'
import { OtterAvatar } from '../../components/OtterAvatar'
import { ScheduledTaskSection } from './ScheduledTaskSection'

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

export function RightPanel(props: RightPanelProps) {
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

  return (
    <aside className="w-64 glass rounded-3xl flex flex-col overflow-y-auto flex-shrink-0">
      {/* Otter Participants */}
      <div className="p-4 border-b border-white/40">
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

      {/* 关键资源（统一产物模型：fact 为文本事实，其余为 url/pr/file 等链接） */}
      <div className="p-4 border-b border-white/40">
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

      {/* Scheduled Tasks */}
      <div className="p-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 mb-2 flex justify-between items-center">
          <span className="flex items-center gap-1">
            <Clock size={12} />
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
    </aside>
  )
}

function OtterParticipantCard({
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

  return (
    <div
      onClick={onClick}
      className="flex items-center gap-2 px-2.5 py-2 rounded-xl cursor-pointer glass-card mb-1.5 transition hover:shadow-bubble hover:-translate-y-0.5 group"
    >
      <OtterAvatar otterId={o.id} name={o.name} size={28} />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-stone-700">{o.name}</div>
        <div className="text-[10px] text-stone-400">{isBig ? '大獭 · 持久' : (o.role?.name || '')}</div>
        {activeS && (
          <div className="text-[9px] text-stone-400">
            第{activeGen}世 · {activeS.startedAt.split(' ')[1] || activeS.startedAt}
          </div>
        )}
      </div>
      {/* 模型标签：未配置（大獭/老数据/默认模型）不渲染，与"大獭"badge 同视觉权重 */}
      {o.modelAlias && (
        <span className="text-[9px] font-semibold px-2 py-0.5 rounded-full bg-stone-400/15 text-stone-500">{o.modelAlias}</span>
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
  )
}

function FactItem({ fact: f, onToggleFlag, onDelete }: { fact: LinkedResource; onToggleFlag: () => void; onDelete: () => void }) {
  return (
    <div className="flex items-start gap-1.5 px-1.5 py-1 rounded-lg hover:bg-white/30 transition group">
      <span
        onClick={onToggleFlag}
        className={`cursor-pointer mt-0.5 ${f.flagged ? 'text-amber-400' : 'text-stone-300'}`}
      >
        <Star className="w-3.5 h-3.5" fill={f.flagged ? 'currentColor' : 'none'} />
      </span>
      <span className="text-xs text-stone-600 flex-1 min-w-0 flex flex-col gap-1">
        {/* 长事实截断，悬停原生 tooltip 显示全文（沿用项目 title 属性惯例） */}
        <span className="truncate" title={f.content ?? undefined}>{f.content}</span>
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
    </div>
  )
}

function LinkedResourceItem({ resource: r, onDelete }: { resource: LinkedResource; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-1.5 px-1.5 py-1 rounded-lg hover:bg-white/30 transition group">
      {/* 与 FactItem 统一为 stone 色系：链接类资源加类型色块，长标题截断 + tooltip 显示全文（含 url） */}
      <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-stone-100 text-stone-500 uppercase flex-shrink-0">{r.type}</span>
      <span className="text-xs text-stone-600 truncate flex-1" title={r.url || r.title || undefined}>
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
    </div>
  )
}
