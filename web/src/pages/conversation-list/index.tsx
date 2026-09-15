import { useState, useEffect, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import '../../styles/globals.css'

import type { ModelInfoDTO } from '@contract/api'
import type { LocalConversation } from '../../lib/mappers'
import { mapConversationDTO } from '../../lib/mappers'
import { showToast } from '../../components/Toast'
import { AppLayout } from '../../components/AppLayout'
import { Modal, ModalButton } from '../../components/Modal'
import { LeftPanel } from '../conversation/LeftPanel'
import { useConversationListPolling } from '../../hooks/use-conversation-list-polling'
import * as api from '../../api/client'
import { getSettings, ApiError } from '../../api/client'

/** 新建对话弹窗的「大獭模型」下拉块（检视发现 3 抽取消重）：空列表态/常规态两处 Modal 共用。
 *  models 为空（settings 未返回/加载失败）时整体不渲染——降级走服务端默认模型 */
function BigOtterModelDropdown({ models, defaultAlias, selectedModel, onSelect }: {
  models: ModelInfoDTO[]
  defaultAlias: string
  selectedModel: string
  onSelect: (alias: string) => void
}) {
  if (models.length === 0) return null
  return (
    <>
      <label className="block text-xs font-medium text-stone-500 mt-3 mb-1.5">大獭模型</label>
      <select value={selectedModel} onChange={e => onSelect(e.target.value)} className="form-input w-full">
        {models.map(m => (
          <option key={m.alias} value={m.alias}>
            {m.alias === defaultAlias ? `${m.alias}（默认）` : m.alias}{m.description ? ` — ${m.description}` : ''}
          </option>
        ))}
      </select>
      <p className="text-[11px] text-stone-400 mt-1">默认取配置文件；某家配额耗尽时可在此换模型</p>
    </>
  )
}

export default function ConversationListPage() {
  const [conversations, setConversations] = useState<LocalConversation[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  /** 新建对话选大獭模型：与 conversation 页 NewConvModal 同款下拉（默认 = 配置文件默认模型）。
   *  加载失败降级为不展示下拉，创建请求不下发 modelAlias（走服务端默认） */
  const [models, setModels] = useState<ModelInfoDTO[]>([])
  const [defaultAlias, setDefaultAlias] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; cid: string } | null>(null)

  const activeConvForMenu = ctxMenu ? conversations.find(c => c.id === ctxMenu.cid) : null

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
    // 归档成功后通过 URL 参数接收 toast
    const params = new URLSearchParams(window.location.search)
    if (params.get('archived') === '1') {
      showToast('对话已归档', 'success')
      window.history.replaceState(null, '', '/conversation')
    }
  }, [])

  // 活动状态轮询：每 5 秒刷新对话列表（仅在页面可见时）
  useConversationListPolling(!loading, setConversations)

  const handleSelect = useCallback((id: string) => {
    // 混合架构：切换对话时整页刷新
    window.location.href = `/conversation/${id}`
  }, [])

  const handleNewConversation = useCallback(() => {
    setShowCreate(true)
    setNewTitle('')
    // 每次打开弹窗拉一次 settings：默认模型可能已被切换，不用陈旧缓存
    getSettings()
      .then(s => {
        setModels(s.models)
        setDefaultAlias(s.defaultModelAlias)
        setSelectedModel(s.defaultModelAlias)
      })
      .catch(() => console.warn('[ConversationListPage] Failed to load models for dropdown'))
  }, [])

  const handleCreateConversation = useCallback(async () => {
    if (!newTitle.trim()) {
      showToast('请输入对话标题', 'error')
      return
    }
    try {
      const dto = await api.createConversation({ title: newTitle, modelAlias: selectedModel || undefined })
      const conv = mapConversationDTO(dto)
      setConversations(prev => [conv, ...prev])
      setShowCreate(false)
      showToast('对话已创建', 'success')
      // 混合架构：创建新对话后整页刷新，确保 URL 与内容一致
      window.location.href = `/conversation/${conv.id}`
    } catch {
      showToast('创建对话失败', 'error')
    }
  }, [newTitle, selectedModel])

  const handleContextMenu = useCallback((e: React.MouseEvent, cid: string) => {
    e.preventDefault()
    // F20260826pfix：视口钳位——贴边右键时菜单不出屏（与会话页 index.tsx:1110 同款防护）
    const x = Math.min(e.clientX, window.innerWidth - 168)
    const y = Math.min(e.clientY, window.innerHeight - 90)
    setCtxMenu({ x, y, cid })
  }, [])

  const closeCtxMenu = useCallback(() => setCtxMenu(null), [])

  const ctxAction = async (action: string, cid: string) => {
    closeCtxMenu()
    if (action === 'pin') {
      showToast('正在置顶...', 'info')
      try {
        await api.pinConversation(cid)
        window.location.reload()
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : '置顶失败', 'error')
      }
    } else if (action === 'unpin') {
      showToast('正在取消置顶...', 'info')
      try {
        await api.unpinConversation(cid)
        window.location.reload()
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          showToast('系统对话不可取消置顶', 'error')
        } else {
          showToast(err instanceof ApiError ? err.message : '取消置顶失败', 'error')
        }
      }
    }
  }

  if (loading) {
    return (
      <AppLayout activeView="index">
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
      <AppLayout activeView="index">
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

        <Modal
          isOpen={showCreate}
          onClose={() => setShowCreate(false)}
          title="新建对话"
          footer={
            <>
              <ModalButton onClick={() => setShowCreate(false)}>取消</ModalButton>
              <ModalButton variant="primary" onClick={handleCreateConversation}>创建</ModalButton>
            </>
          }
        >
          <label className="block text-xs font-medium text-stone-500 mb-1.5">对话标题</label>
          <input
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreateConversation()}
            className="form-input w-full"
            placeholder="输入对话标题..."
            autoFocus
          />
          <BigOtterModelDropdown models={models} defaultAlias={defaultAlias} selectedModel={selectedModel} onSelect={setSelectedModel} />
        </Modal>
      </AppLayout>
    )
  }

  return (
    <AppLayout activeView="index">
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

      <Modal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        title="新建对话"
        footer={
          <>
            <ModalButton onClick={() => setShowCreate(false)}>取消</ModalButton>
            <ModalButton variant="primary" onClick={handleCreateConversation}>创建</ModalButton>
          </>
        }
      >
        <label className="block text-xs font-medium text-stone-500 mb-1.5">对话标题</label>
        <input
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleCreateConversation()}
          className="form-input w-full"
          placeholder="输入对话标题..."
          autoFocus
        />
        <BigOtterModelDropdown models={models} defaultAlias={defaultAlias} selectedModel={selectedModel} onSelect={setSelectedModel} />
      </Modal>

      {ctxMenu && activeConvForMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeCtxMenu} />
          <div className="fixed glass-overlay rounded-2xl p-1 z-50 min-w-[150px]" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <div onClick={() => ctxAction(activeConvForMenu.pinned ? 'unpin' : 'pin', ctxMenu.cid)} className="px-2.5 py-1.5 rounded-lg text-xs cursor-pointer hover:bg-white/40 text-stone-600">
              {activeConvForMenu.pinned ? '取消置顶' : '置顶'}
            </div>
          </div>
        </>
      )}
    </AppLayout>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<ConversationListPage />)
