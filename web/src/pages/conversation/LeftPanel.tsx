import { Search, Plus, Pin } from 'lucide-react'
import type { LocalConversation as Conversation, LocalOtter as Otter } from '../../lib/mappers'
import { getOtterColor } from '../../lib/otter-colors'

interface LeftPanelProps {
  conversations: Conversation[]
  activeId: string
  onSelect: (id: string) => void
  onNewConversation: () => void
  onContextMenu: (e: React.MouseEvent, cid: string) => void
  otters: Otter[]
}

export function LeftPanel({ conversations, activeId, onSelect, onNewConversation, onContextMenu, otters }: LeftPanelProps) {
  const pinnedConvs = conversations.filter(c => c.pinned)
  const normalConvs = conversations.filter(c => !c.pinned)

  return (
    <aside className="w-56 glass rounded-3xl flex flex-col flex-shrink-0 overflow-hidden">
      <div className="p-3 flex gap-2 border-b border-white/40">
        <a
          href="/memory"
          className="w-8 h-8 rounded-xl flex items-center justify-center text-stone-500 hover:bg-white/40 transition"
        >
          <Search className="w-4 h-4" />
        </a>
        <button
          onClick={onNewConversation}
          className="flex-1 py-1.5 text-xs font-medium text-otter-500 border border-otter-300/30 rounded-xl hover:bg-white/40 transition flex items-center justify-center gap-1"
        >
          <Plus className="w-3.5 h-3.5" /> 新建对话
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {pinnedConvs.length > 0 && (
          <div className="px-2.5 pt-1 pb-0.5 text-[10px] font-medium text-stone-400 uppercase tracking-wide">置顶</div>
        )}
        {pinnedConvs.map(c => (
          <ConversationItem
            key={c.id}
            conversation={c}
            isActive={c.id === activeId}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            otters={otters}
          />
        ))}
        {pinnedConvs.length > 0 && normalConvs.length > 0 && (
          <div className="my-1 border-t border-white/30" />
        )}
        {normalConvs.map(c => (
          <ConversationItem
            key={c.id}
            conversation={c}
            isActive={c.id === activeId}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            otters={otters}
          />
        ))}
      </div>
    </aside>
  )
}

function ConversationItem({
  conversation: c,
  isActive,
  onSelect,
  onContextMenu,
  otters,
}: {
  conversation: Conversation
  isActive: boolean
  onSelect: (id: string) => void
  onContextMenu: (e: React.MouseEvent, cid: string) => void
  otters: Otter[]
}) {
  const convOtters: Otter[] = c.otterIds
    .map(id => otters.find(o => o.id === id))
    .filter((o): o is Otter => o !== undefined)

  return (
    <div
      onClick={() => onSelect(c.id)}
      onContextMenu={e => onContextMenu(e, c.id)}
      className={`px-2.5 py-2 rounded-xl cursor-pointer transition ${
        isActive ? 'conv-active' : 'hover:bg-white/30'
      }`}
    >
      <div className="flex items-center gap-1.5">
        <div className="text-xs font-medium text-stone-700 truncate flex-1 flex items-center gap-1">
          {c.pinned && <Pin className="w-3 h-3 text-otter-400 flex-shrink-0" />}
          <span className="truncate">{c.title}</span>
        </div>
        {c.unreadCount != null && c.unreadCount > 0 && (
          <span className="min-w-[16px] h-4 px-1 rounded-full bg-red-400 text-white text-[9px] font-bold flex items-center justify-center flex-shrink-0">
            {c.unreadCount > 99 ? '99+' : c.unreadCount}
          </span>
        )}
      </div>
      {c.lastMessagePreview && (
        <div className="text-[10px] text-stone-400 truncate mt-0.5">{c.lastMessagePreview}</div>
      )}
      <div className="flex items-center gap-1 mt-0.5">
        <div className="flex items-center gap-0.5">
          <div
            className={`w-1 h-1 rounded-full ${
              c.status === 'active' ? 'bg-teal-400' : c.status === 'completed' ? 'bg-otter-400' : 'bg-stone-400'
            }`}
          />
          {c.activityStatus === 'processing' && (
            <span className="flex items-center gap-0.5">
              <div className="w-1 h-1 rounded-full bg-teal-400 animate-pulse" />
              <span className="text-[9px] text-teal-500">处理中</span>
            </span>
          )}
          {c.activityStatus === 'awaiting_user' && (
            <span className="flex items-center gap-0.5">
              <div className="w-1 h-1 rounded-full bg-amber-400" />
              <span className="text-[9px] text-amber-500">等待中</span>
            </span>
          )}
        </div>
        <div className="flex ml-auto">
          {convOtters.map(o => {
            const color = getOtterColor(o.id)
            return (
              <div
                key={o.id}
                className="w-4 h-4 rounded-full border-2 border-white flex items-center justify-center text-[7px] font-bold text-white"
                style={{ background: color.hex }}
              >
                {o.name.charAt(0)}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
