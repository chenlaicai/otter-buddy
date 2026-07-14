import { useState, useRef, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { AlertTriangle } from 'lucide-react'
import '../../styles/globals.css'

import type { Conversation, Message, Otter, KeyFact, LinkedResource, OtterSession } from '../../mock/data'
import {
  bigOtter,
  smallOtters as initialSmallOtters,
  otterSessions as initialSessions,
  conversations as initialConversations,
  messages as initialMessages,
  keyFacts as initialKeyFacts,
  linkedResources as initialLinkedResources,
} from '../../mock/data'
import { nowTs } from '../../lib/utils'
import { AppLayout } from '../../components/AppLayout'
import { showToast } from '../../components/Toast'
import { LeftPanel } from './LeftPanel'
import { ChatView } from './ChatView'
import { RightPanel } from './RightPanel'
import { ConversationModals, type ModalState } from './Modals'
import type { StreamingState } from './MessageList'

// TODO: API contract not yet defined - all data is mocked

function ConversationPage() {
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations)
  const [activeId, setActiveId] = useState('c1')
  const [allMessages, setAllMessages] = useState<Record<string, Message[]>>(initialMessages)
  const [smallOtters, setSmallOtters] = useState<Otter[]>(initialSmallOtters)
  const [sessions, setSessions] = useState<Record<string, OtterSession[]>>(initialSessions)
  const [allKeyFacts, setAllKeyFacts] = useState<Record<string, KeyFact[]>>(initialKeyFacts)
  const [allLinkedRes, setAllLinkedRes] = useState<Record<string, LinkedResource[]>>(initialLinkedResources)
  const [modal, setModal] = useState<ModalState>({ type: 'none' })
  const [streaming, setStreaming] = useState<StreamingState | null>(null)
  const [pageState, setPageState] = useState<'normal' | 'empty' | 'loading' | 'error' | 'no-llm'>('normal')
  const [wsDisconnected] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; cid: string } | null>(null)
  const streamIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const activeConv = conversations.find(c => c.id === activeId) || null
  const activeMessages = allMessages[activeId] || []
  const activeKeyFacts = allKeyFacts[activeId] || []
  const activeLinkedRes = allLinkedRes[activeId] || []
  const allOttersList: Otter[] = [bigOtter, ...smallOtters]
  const activeOtters: Otter[] = (activeConv?.otterIds || [])
    .map(id => allOttersList.find(o => o.id === id))
    .filter((o): o is Otter => o !== undefined)

  const stopStream = useCallback(() => {
    if (streamIntervalRef.current) {
      clearInterval(streamIntervalRef.current)
      streamIntervalRef.current = null
    }
    // Finalize the streaming message into the messages list
    if (streaming) {
      const newMsg: Message = {
        id: 'm' + Date.now(),
        st: 'otter',
        si: streaming.otterId,
        sp: streaming.streamingText,
        content: streaming.finalText || streaming.streamingText,
        ts: nowTs(),
        dur: `${streaming.duration.toFixed(1)}s`,
        ctx: 850,
        ctxMax: 128000,
      }
      setAllMessages(prev => ({
        ...prev,
        [activeId]: [...(prev[activeId] || []), newMsg],
      }))
    }
    setStreaming(null)
  }, [activeId, streaming])

  const simulateStream = useCallback((otterId: string = 'o1') => {
    const spText = '> 检索记忆: "用户需求"\n> 找到 3 条相关记忆\n> 分析上下文\n> 生成回复中...'
    const finalText = '好的，我来处理这个需求。\n\n**分析要点：**\n\n1. 需要覆盖所有页面\n2. 交互必须可演示\n3. 组件结构需对应 React\n\n```typescript\nconst result = await process(input);\n```\n\n这个方案如何？'
    const startTime = Date.now()

    setStreaming({
      otterId,
      streamingText: '',
      finalText,
      showFinal: false,
      duration: 0,
    })

    let idx = 0
    streamIntervalRef.current = setInterval(() => {
      if (idx >= spText.length) {
        // Streaming process complete, show final response
        if (streamIntervalRef.current) {
          clearInterval(streamIntervalRef.current)
          streamIntervalRef.current = null
        }
        const dur = (Date.now() - startTime) / 1000

        // Finalize: add to messages
        const newMsg: Message = {
          id: 'm' + Date.now(),
          st: 'otter',
          si: otterId,
          sp: spText,
          content: finalText,
          ts: nowTs(),
          dur: `${dur.toFixed(1)}s`,
          ctx: 850,
          ctxMax: 128000,
        }
        setAllMessages(prev => ({
          ...prev,
          [activeId]: [...(prev[activeId] || []), newMsg],
        }))
        setStreaming(null)
        return
      }
      idx += 3
      const partial = spText.substring(0, idx)
      setStreaming(prev => prev ? { ...prev, streamingText: partial, duration: (Date.now() - startTime) / 1000 } : null)
    }, 40)
  }, [activeId])

  const handleSend = useCallback((text: string, mentionOtterId?: string) => {
    const userMsg: Message = {
      id: 'm' + Date.now(),
      st: 'user',
      si: 'user',
      content: text,
      ts: nowTs(),
      dur: null,
      ctx: 850,
      ctxMax: 128000,
    }
    setAllMessages(prev => ({
      ...prev,
      [activeId]: [...(prev[activeId] || []), userMsg],
    }))

    // Simulate otter response
    const otterId = mentionOtterId || 'o1'
    setTimeout(() => simulateStream(otterId), 400)
  }, [activeId, simulateStream])

  const handleSelectConv = useCallback((id: string) => {
    setActiveId(id)
    setPageState('normal')
  }, [])

  const handleNewConv = () => setModal({ type: 'new-conv' })
  const handleCreateChild = () => setModal({ type: 'child', parentId: activeId })
  const handleComplete = () => setModal({ type: 'complete', cid: activeId })
  const handleArchive = () => setModal({ type: 'archive', cid: activeId })

  const handleContextMenu = (e: React.MouseEvent, cid: string) => {
    e.preventDefault()
    const menuW = 160, menuH = 130
    const x = Math.min(e.clientX, window.innerWidth - menuW - 8)
    const y = Math.min(e.clientY, window.innerHeight - menuH - 8)
    setCtxMenu({ x, y, cid })
  }

  function closeCtxMenu() {
    setCtxMenu(null)
  }

  // Modal confirm handlers
  function confirmNewConv(title: string) {
    const newConv: Conversation = {
      id: 'c' + Date.now(),
      title,
      status: 'active',
      parentId: null,
      otterIds: ['o1'],
    }
    setConversations(prev => [newConv, ...prev])
    setAllMessages(prev => ({ ...prev, [newConv.id]: [] }))
    setActiveId(newConv.id)
    setModal({ type: 'none' })
    showToast('对话已创建', 'success')
  }

  function confirmChild(title: string) {
    if (modal.type !== 'child') return
    const newConv: Conversation = {
      id: 'c' + Date.now(),
      title,
      status: 'active',
      parentId: modal.parentId,
      otterIds: ['o1'],
    }
    setConversations(prev => [...prev, newConv])
    setAllMessages(prev => ({ ...prev, [newConv.id]: [] }))
    setActiveId(newConv.id)
    setModal({ type: 'none' })
    showToast('子对话已创建', 'success')
  }

  function confirmComplete() {
    setConversations(prev => prev.map(c => c.id === activeId ? { ...c, status: 'completed' } : c))
    setModal({ type: 'none' })
    showToast('对话已完成', 'success')
  }

  function confirmArchive() {
    setConversations(prev => prev.map(c => c.id === activeId ? { ...c, status: 'archived' } : c))
    setModal({ type: 'none' })
    showToast('对话已归档', 'success')
  }

  function confirmCreateOtter(name: string, role: string, resp: string[]) {
    const ci = (smallOtters.length % 4) + 1
    const newOtter: Otter = {
      id: 'o' + Date.now(),
      name,
      type: 'small',
      role: { name: role, resp },
      parentOtterId: 'o1',
      ci,
      createdAt: nowTs().split(' ')[0],
    }
    setSmallOtters(prev => [...prev, newOtter])
    setSessions(prev => ({
      ...prev,
      [newOtter.id]: [{
        id: 's' + Date.now(),
        otterId: newOtter.id,
        status: 'active',
        startedAt: nowTs(),
        archivedAt: null,
        archiveReason: null,
        isNegativeCase: false,
        summary: null,
      }],
    }))
    setConversations(prev => prev.map(c =>
      c.id === activeId ? { ...c, otterIds: [...c.otterIds, newOtter.id] } : c
    ))
    setModal({ type: 'none' })
    showToast(`小獭 ${name} 已创建`, 'success')
  }

  function confirmDissolve(summary: string) {
    if (modal.type !== 'dissolve') return
    const oid = modal.otterId
    // Archive active session
    setSessions(prev => {
      const otterSessions = prev[oid] || []
      const updated = otterSessions.map(s =>
        s.status === 'active'
          ? { ...s, status: 'archived' as const, archivedAt: nowTs(), archiveReason: 'dissolve', summary }
          : s
      )
      return { ...prev, [oid]: updated }
    })
    setSmallOtters(prev => prev.filter(o => o.id !== oid))
    setConversations(prev => prev.map(c => ({
      ...c,
      otterIds: c.otterIds.filter(id => id !== oid),
    })))
    setModal({ type: 'none' })
    showToast('小獭已解散', 'success')
  }

  function confirmRestart(summary: string) {
    if (modal.type !== 'restart') return
    const oid = modal.otterId
    setSessions(prev => {
      const otterSessions = prev[oid] || []
      const updated = otterSessions.map(s =>
        s.status === 'active'
          ? { ...s, status: 'archived' as const, archivedAt: nowTs(), archiveReason: 'restart', isNegativeCase: true, summary }
          : s
      )
      return {
        ...prev,
        [oid]: [...updated, {
          id: 's' + Date.now(),
          otterId: oid,
          status: 'active',
          startedAt: nowTs(),
          archivedAt: null,
          archiveReason: null,
          isNegativeCase: false,
          summary: null,
        }],
      }
    })
    setModal({ type: 'none' })
    showToast('Session 已封存，新 Session 已开始', 'success')
  }

  function confirmLinkResource(type: string, url: string, title: string) {
    const newRes: LinkedResource = {
      id: 'lr' + Date.now(),
      type,
      url,
      title,
      auto: false,
    }
    setAllLinkedRes(prev => ({
      ...prev,
      [activeId]: [...(prev[activeId] || []), newRes],
    }))
    setModal({ type: 'none' })
    showToast('资源已链接', 'success')
  }

  function addKeyFact(content: string, category: string) {
    const newFact: KeyFact = {
      id: 'kf' + Date.now(),
      content,
      category,
      flagged: false,
    }
    setAllKeyFacts(prev => ({
      ...prev,
      [activeId]: [...(prev[activeId] || []), newFact],
    }))
    showToast('关键事实已添加', 'success')
  }

  function toggleKeyFact(id: string) {
    setAllKeyFacts(prev => ({
      ...prev,
      [activeId]: (prev[activeId] || []).map(f => f.id === id ? { ...f, flagged: !f.flagged } : f),
    }))
  }

  function deleteKeyFact(id: string) {
    setAllKeyFacts(prev => ({
      ...prev,
      [activeId]: (prev[activeId] || []).filter(f => f.id !== id),
    }))
  }

  function deleteLinkedResource(id: string) {
    setAllLinkedRes(prev => ({
      ...prev,
      [activeId]: (prev[activeId] || []).filter(r => r.id !== id),
    }))
  }

  // Context menu actions
  function ctxAction(action: string, cid: string) {
    closeCtxMenu()
    setActiveId(cid)
    if (action === 'complete') setModal({ type: 'complete', cid })
    if (action === 'archive') setModal({ type: 'archive', cid })
    if (action === 'child') setModal({ type: 'child', parentId: cid })
  }

  const activeConvForMenu = ctxMenu ? conversations.find(c => c.id === ctxMenu.cid) : null

  return (
    <AppLayout
      activeView="conversation"
      wsBar={wsDisconnected ? (
        <div className="bg-amber-400 text-white text-center text-xs py-1.5 flex items-center justify-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" /> 连接已断开，正在重连...
        </div>
      ) : undefined}
    >
      <div className="flex flex-1 overflow-hidden p-3 gap-3">
        <LeftPanel
          conversations={conversations}
          activeId={activeId}
          onSelect={handleSelectConv}
          onNewConversation={handleNewConv}
          onContextMenu={handleContextMenu}
          otters={allOttersList}
        />

        <ChatView
          conversation={activeConv}
          messages={activeMessages}
          streamingMessage={streaming}
          state={pageState}
          onSend={handleSend}
          onStopStream={stopStream}
          onRetry={() => { setPageState('normal'); showToast('正在重试...', 'info') }}
          onGoToSettings={() => { window.location.href = '/settings' }}
          onCreateChild={handleCreateChild}
          onComplete={handleComplete}
          onArchive={handleArchive}
          otters={allOttersList}
        />

        <RightPanel
          conversation={activeConv || conversations[0]}
          otters={activeOtters}
          sessions={sessions}
          keyFacts={activeKeyFacts}
          linkedResources={activeLinkedRes}
          onCreateSmallOtter={() => setModal({ type: 'create-otter' })}
          onDissolveOtter={(oid) => setModal({ type: 'dissolve', otterId: oid })}
          onRestartOtter={(oid) => setModal({ type: 'restart', otterId: oid })}
          onOpenOtterDetail={(oid) => setModal({ type: 'otter-detail', otterId: oid })}
          onAddKeyFact={addKeyFact}
          onToggleKeyFact={toggleKeyFact}
          onDeleteKeyFact={deleteKeyFact}
          onAddLinkedResource={() => setModal({ type: 'link-resource' })}
          onDeleteLinkedResource={deleteLinkedResource}
        />
      </div>

      {/* Context Menu */}
      {ctxMenu && activeConvForMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeCtxMenu} />
          <div
            className="fixed glass-strong rounded-2xl shadow-otter-lg p-1 z-50 min-w-[150px]"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
          >
            <div
              onClick={() => ctxAction('complete', ctxMenu.cid)}
              className={`px-2.5 py-1.5 rounded-lg text-xs cursor-pointer ${
                activeConvForMenu.status === 'active'
                  ? 'hover:bg-white/40 text-stone-600'
                  : 'text-stone-300 cursor-not-allowed'
              }`}
            >
              完成对话
            </div>
            <div
              onClick={() => ctxAction('archive', ctxMenu.cid)}
              className={`px-2.5 py-1.5 rounded-lg text-xs cursor-pointer ${
                activeConvForMenu.status !== 'archived'
                  ? 'hover:bg-white/40 text-stone-600'
                  : 'text-stone-300 cursor-not-allowed'
              }`}
            >
              归档对话
            </div>
            <div
              onClick={() => ctxAction('child', ctxMenu.cid)}
              className="px-2.5 py-1.5 rounded-lg text-xs cursor-pointer hover:bg-white/40 text-stone-600"
            >
              创建子对话
            </div>
          </div>
        </>
      )}

      {/* All Modals */}
      <ConversationModals
        modal={modal}
        otters={allOttersList}
        sessions={sessions}
        onClose={() => setModal({ type: 'none' })}
        onConfirmNewConv={confirmNewConv}
        onConfirmChild={confirmChild}
        onConfirmComplete={confirmComplete}
        onConfirmArchive={confirmArchive}
        onConfirmCreateOtter={confirmCreateOtter}
        onConfirmDissolve={confirmDissolve}
        onConfirmRestart={confirmRestart}
        onConfirmLinkResource={confirmLinkResource}
        onOpenRestart={(oid) => setModal({ type: 'restart', otterId: oid })}
        onOpenDissolve={(oid) => setModal({ type: 'dissolve', otterId: oid })}
      />
    </AppLayout>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<ConversationPage />)
