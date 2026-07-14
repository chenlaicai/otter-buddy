import { useState } from 'react'
import { Search, Plus } from 'lucide-react'
import type { Conversation, Otter } from '../../mock/data'
import { getOtterColor } from '../../mock/data'

interface LeftPanelProps {
  conversations: Conversation[]
  activeId: string
  onSelect: (id: string) => void
  onNewConversation: () => void
  onContextMenu: (e: React.MouseEvent, cid: string) => void
}

export function LeftPanel({ conversations, activeId, onSelect, onNewConversation, onContextMenu }: LeftPanelProps) {
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
        {conversations.map(c => (
          <ConversationItem
            key={c.id}
            conversation={c}
            isActive={c.id === activeId}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
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
}: {
  conversation: Conversation
  isActive: boolean
  onSelect: (id: string) => void
  onContextMenu: (e: React.MouseEvent, cid: string) => void
}) {
  // Mock otter data for avatar display
  const otters: Otter[] = c.otterIds.map(id => {
    if (id === 'o1') return { id: 'o1', name: '大獭', type: 'big', createdAt: '' }
    return { id, name: id, type: 'small', createdAt: '' }
  })

  return (
    <div
      onClick={() => onSelect(c.id)}
      onContextMenu={e => onContextMenu(e, c.id)}
      className={`px-2.5 py-2 rounded-xl cursor-pointer transition ${
        isActive ? 'glass-card shadow-bubble' : 'hover:bg-white/30'
      }`}
    >
      <div className="text-xs font-medium text-stone-700 truncate">{c.title}</div>
      <div className="flex items-center gap-1 mt-0.5">
        <div
          className={`w-1 h-1 rounded-full ${
            c.status === 'active' ? 'bg-teal-400' : c.status === 'completed' ? 'bg-otter-400' : 'bg-stone-400'
          }`}
        />
        <div className="flex ml-auto">
          {otters.map(o => {
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
