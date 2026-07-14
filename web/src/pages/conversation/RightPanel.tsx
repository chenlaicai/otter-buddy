import { useState } from 'react'
import { Plus, Star, X, MoreHorizontal, RotateCcw } from 'lucide-react'
import type { Conversation, Otter, KeyFact, LinkedResource } from '../../mock/data'
import { otterSessions as mockSessions } from '../../mock/data'
import { OtterAvatar } from '../../components/OtterAvatar'

interface RightPanelProps {
  conversation: Conversation
  otters: Otter[]
  keyFacts: KeyFact[]
  linkedResources: LinkedResource[]
  onCreateSmallOtter: () => void
  onDissolveOtter: (otterId: string) => void
  onRestartOtter: (otterId: string) => void
  onOpenOtterDetail: (otterId: string) => void
  onAddKeyFact: (content: string, category: string) => void
  onToggleKeyFact: (id: string) => void
  onDeleteKeyFact: (id: string) => void
  onAddLinkedResource: () => void
  onDeleteLinkedResource: (id: string) => void
}

export function RightPanel(props: RightPanelProps) {
  const [showKfForm, setShowKfForm] = useState(false)
  const [kfContent, setKfContent] = useState('')
  const [kfCategory, setKfCategory] = useState('')

  function handleAddKeyFact() {
    if (!kfContent.trim()) return
    props.onAddKeyFact(kfContent, kfCategory)
    setKfContent('')
    setKfCategory('')
    setShowKfForm(false)
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

      {/* Key Facts */}
      <div className="p-4 border-b border-white/40">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 mb-2 flex justify-between items-center">
          关键事实
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
              placeholder="关键事实内容"
              className="form-input text-xs"
            />
            <input
              value={kfCategory}
              onChange={e => setKfCategory(e.target.value)}
              placeholder="分类 (可选)"
              className="form-input text-xs"
            />
            <div className="flex gap-1.5 justify-end">
              <button onClick={() => setShowKfForm(false)} className="px-2.5 py-1 text-xs text-stone-500">取消</button>
              <button
                onClick={handleAddKeyFact}
                className="px-2.5 py-1 text-xs text-white rounded-lg"
                style={{ background: 'linear-gradient(135deg,#A88260,#6B5638)' }}
              >
                添加
              </button>
            </div>
          </div>
        )}
        <div>
          {props.keyFacts.map(f => (
            <div key={f.id} className="flex items-start gap-1.5 px-1.5 py-1 rounded-lg hover:bg-white/30 transition group">
              <span
                onClick={() => props.onToggleKeyFact(f.id)}
                className={`cursor-pointer mt-0.5 ${f.flagged ? 'text-amber-400' : 'text-stone-300'}`}
              >
                <Star className="w-3.5 h-3.5" fill={f.flagged ? 'currentColor' : 'none'} />
              </span>
              <span className="text-xs text-stone-600 flex-1">
                {f.content}
                {f.category && (
                  <span className="text-[9px] text-stone-400 bg-white/30 px-1.5 py-0.5 rounded-full ml-1">
                    {f.category}
                  </span>
                )}
              </span>
              <span
                onClick={() => props.onDeleteKeyFact(f.id)}
                className="opacity-0 group-hover:opacity-100 text-red-400 mt-0.5 cursor-pointer"
              >
                <X className="w-3 h-3" />
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Linked Resources */}
      <div className="p-4 border-b border-white/40">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 mb-2 flex justify-between items-center">
          链接资源
          <button
            onClick={props.onAddLinkedResource}
            className="text-stone-400 hover:text-otter-500 w-5 h-5 flex items-center justify-center rounded"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </h3>
        <div>
          {props.linkedResources.map(r => (
            <LinkedResourceItem key={r.id} resource={r} onDelete={() => props.onDeleteLinkedResource(r.id)} />
          ))}
        </div>
      </div>
    </aside>
  )
}

function OtterParticipantCard({
  otter: o,
  onClick,
  onDissolve,
  onRestart,
}: {
  otter: Otter
  onClick: () => void
  onDissolve: (id: string) => void
  onRestart: (id: string) => void
}) {
  const isBig = o.type === 'big'
  const sessions = mockSessions[o.id] || []
  const activeS = sessions.find(s => s.status === 'active')

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
            Session #{sessions.length} · {activeS.startedAt.split(' ')[1] || activeS.startedAt}
          </div>
        )}
      </div>
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
      <button
        onClick={e => { e.stopPropagation(); onRestart(o.id) }}
        className="opacity-0 group-hover:opacity-100 text-[10px] text-red-400 px-1.5 py-0.5 rounded hover:bg-red-400/10 transition flex items-center gap-0.5"
      >
        <RotateCcw className="w-2.5 h-2.5" />
        重启
      </button>
    </div>
  )
}

function LinkedResourceItem({ resource: r, onDelete }: { resource: LinkedResource; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-1.5 px-1.5 py-1 rounded-lg hover:bg-white/30 transition group">
      <span className="text-xs text-teal-500 truncate flex-1">{r.title || r.url}</span>
      {r.auto && (
        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-teal-400/15 text-teal-500">自动</span>
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
