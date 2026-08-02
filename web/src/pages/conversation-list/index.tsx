import { useState, useEffect, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import '../../styles/globals.css'

import type { LocalConversation } from '../../lib/mappers'
import { mapConversationDTO } from '../../lib/mappers'
import { showToast } from '../../components/Toast'
import { AppLayout } from '../../components/AppLayout'
import { LeftPanel } from '../conversation/LeftPanel'
import * as api from '../../api/client'

export default function ConversationListPage() {
  const [conversations, setConversations] = useState<LocalConversation[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')

  // TODO: 实现创建对话 Modal
  void showCreate
  void newTitle
  void setShowCreate
  void setNewTitle

  useEffect(() => {
    api.listConversations()
      .then(dtos => {
        setConversations(dtos.map(mapConversationDTO))
        setLoading(false)
      })
      .catch(() => {
        showToast('加载对话列表失败', 'error')
        setLoading(false)
      })
  }, [])

  const handleSelect = useCallback((id: string) => {
    // 混合架构：切换对话时整页刷新
    window.location.href = `/conversation/${id}`
  }, [])

  const handleNewConversation = useCallback(() => {
    // TODO: 实现创建对话 Modal
    showToast('创建对话功能待实现', 'info')
  }, [])

  const handleContextMenu = useCallback((e: React.MouseEvent, _cid: string) => {
    e.preventDefault()
    // Context menu handled in detail page
  }, [])

  if (loading) {
    return (
      <AppLayout activeView="conversation">
        <div className="flex flex-1 items-center justify-center">
          <div className="flex gap-1">
            <span className="w-2 h-2 rounded-full bg-otter-400 animate-dot" />
            <span className="w-2 h-2 rounded-full bg-otter-400 animate-dot" style={{ animationDelay: '0.15s' }} />
            <span className="w-2 h-2 rounded-full bg-otter-400 animate-dot" style={{ animationDelay: '0.3s' }} />
          </div>
        </div>
      </AppLayout>
    )
  }

  if (conversations.length === 0) {
    return (
      <AppLayout activeView="conversation">
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <div className="text-4xl mb-4">🦦</div>
            <div className="text-lg font-medium text-stone-600 mb-2">还没有对话</div>
            <div className="text-sm text-stone-400 mb-4">点击左侧按钮创建第一个对话</div>
            <button
              onClick={handleNewConversation}
              className="px-4 py-2 bg-otter-500 text-white rounded-xl hover:bg-otter-600 transition text-sm"
            >
              新建对话
            </button>
          </div>
        </div>
      </AppLayout>
    )
  }

  return (
    <AppLayout activeView="conversation">
      <div className="flex flex-1 overflow-hidden p-3 gap-3">
        <LeftPanel
          conversations={conversations}
          activeId=""
          onSelect={handleSelect}
          onNewConversation={handleNewConversation}
          onContextMenu={handleContextMenu}
          otters={[]}
        />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-4xl mb-4">🦦</div>
            <div className="text-lg font-medium text-stone-600 mb-2">选择一个对话</div>
            <div className="text-sm text-stone-400">从左侧列表中选择一个对话开始</div>
          </div>
        </div>
      </div>
    </AppLayout>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<ConversationListPage />)
