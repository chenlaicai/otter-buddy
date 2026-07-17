import { useState, useRef, useCallback, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import '../../styles/globals.css'

import type { LocalOtter, LocalConversation, LocalMessage, LocalKeyFact, LocalLinkedResource, LocalOtterSession } from '../../lib/mappers'
import { mapOtterDTO, mapConversationDTO, mapMessageDTO, mapKeyFactDTO, mapLinkedResourceDTO, mapSessionDTO as _mapSessionDTO } from '../../lib/mappers'
import { nowTs } from '../../lib/utils'
import { AppLayout } from '../../components/AppLayout'
import { showToast } from '../../components/Toast'
import { LeftPanel } from './LeftPanel'
import { ChatView } from './ChatView'
import { RightPanel } from './RightPanel'
import { ConversationModals, type ModalState } from './Modals'
import type { StreamingState } from './MessageList'
import * as api from '../../api/client'
import { consumeSSE } from '../../api/sse'

async function loadInitialData(): Promise<{
  bigOtter: LocalOtter
  conversations: LocalConversation[]
}> {
  const bigOtterDTO = await api.getBigOtter()
  const bigOtter = mapOtterDTO(bigOtterDTO)
  const convDTOs = await api.listConversations(bigOtter.id)
  const conversations = convDTOs.map(mapConversationDTO)
  return { bigOtter, conversations }
}

function ConversationPage() {
  const [conversations, setConversations] = useState<LocalConversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [allMessages, setAllMessages] = useState<Record<string, LocalMessage[]>>({})
  const [allOtters, setAllOtters] = useState<LocalOtter[]>([])
  const [sessions, _setSessions] = useState<Record<string, LocalOtterSession[]>>({})
  const [allKeyFacts, setAllKeyFacts] = useState<Record<string, LocalKeyFact[]>>({})
  const [allLinkedRes, setAllLinkedRes] = useState<Record<string, LocalLinkedResource[]>>({})
  const [modal, setModal] = useState<ModalState>({ type: 'none' })
  const [streaming, setStreaming] = useState<StreamingState | null>(null)
  const [pageState, setPageState] = useState<'normal' | 'empty' | 'loading' | 'error' | 'no-llm'>('loading')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; cid: string } | null>(null)
  const sseCtrlRef = useRef<AbortController | null>(null)
  const otterMsgIdRef = useRef<string>('')
  const ciCounter = useRef(1)

  useEffect(() => {
    loadInitialData()
      .then(({ bigOtter, conversations: convs }) => {
        setAllOtters([bigOtter])
        setConversations(convs)
        if (convs.length > 0) {
          setActiveId(convs[0].id)
          setPageState('normal')
        } else {
          setPageState('empty')
        }
      })
      .catch(() => setPageState('error'))
  }, [])

  const loadConversationDetail = useCallback(async (convId: string) => {
    try {
      const [msgs, keyInfo] = await Promise.all([
        api.listMessages(convId, 100),
        api.getKeyInfo(convId),
      ])
      setAllMessages(prev => ({
        ...prev,
        [convId]: msgs.map(mapMessageDTO).reverse(),
      }))
      setAllKeyFacts(prev => ({
        ...prev,
        [convId]: keyInfo.keyFacts.map(mapKeyFactDTO),
      }))
      setAllLinkedRes(prev => ({
        ...prev,
        [convId]: keyInfo.linkedResources.map(mapLinkedResourceDTO),
      }))
    } catch {
      showToast('加载对话详情失败', 'error')
    }
  }, [])

  useEffect(() => {
    if (activeId && !allMessages[activeId]) {
      loadConversationDetail(activeId)
    }
  }, [activeId, allMessages, loadConversationDetail])

  const activeConv = conversations.find(c => c.id === activeId) || null
  const activeMessages = activeId ? (allMessages[activeId] || []) : []
  const activeKeyFacts = activeId ? (allKeyFacts[activeId] || []) : []
  const activeLinkedRes = activeId ? (allLinkedRes[activeId] || []) : []
  const activeOtters: LocalOtter[] = (activeConv?.otterIds || [])
    .map(id => allOtters.find(o => o.id === id))
    .filter((o): o is LocalOtter => o !== undefined)

  const handleSend = useCallback(async (text: string, mentionOtterId?: string) => {
    if (!activeId) return
    const otterId = mentionOtterId || allOtters[0]?.id
    if (!otterId) { showToast('没有可用的 Otter', 'error'); return }

    const userMsg: LocalMessage = {
      id: 'tmp-' + Date.now(), st: 'user', si: 'user',
      content: text, ts: nowTs(), dur: null,
    }
    setAllMessages(prev => ({
      ...prev,
      [activeId]: [...(prev[activeId] || []), userMsg],
    }))

    try {
      const response = await api.sendMessage(activeId, {
        senderId: 'user', talkingStonePassedTo: [otterId], body: text,
      })
      if (!response.ok) { showToast('发送失败', 'error'); return }

      const startTime = Date.now()
      let streamingText = ''
      let otterMessageId = ''

      setStreaming({ otterId, streamingText: '', finalText: '', showFinal: false, duration: 0 })

      const ctrl = consumeSSE(response, {
        'message.start': (data) => { otterMessageId = data.messageId; otterMsgIdRef.current = data.messageId },
        'message.delta': (data) => {
          streamingText += data.text
          setStreaming(prev => prev ? { ...prev, streamingText, duration: (Date.now() - startTime) / 1000 } : null)
        },
        'message.complete': (data) => {
          const finalMsg: LocalMessage = {
            id: data.messageId || otterMessageId, st: 'otter', si: otterId,
            content: streamingText, ts: nowTs(), dur: data.duration, ctx: data.ctx, ctxMax: data.ctxMax,
          }
          setAllMessages(prev => ({ ...prev, [activeId]: [...(prev[activeId] || []), finalMsg] }))
          otterMsgIdRef.current = ''
          setStreaming(null)
        },
        'error': (data) => { showToast(`Agent 错误: ${data.message}`, 'error'); otterMsgIdRef.current = ''; setStreaming(null) },
        'message.aborted': () => { showToast('回复已中断', 'info'); otterMsgIdRef.current = ''; setStreaming(null) },
        'agent.idle': () => {},
      }, { onError: () => { showToast('SSE 连接中断', 'error'); otterMsgIdRef.current = ''; setStreaming(null) } })
      sseCtrlRef.current = ctrl
    } catch {
      showToast('发送失败', 'error'); setStreaming(null)
    }
  }, [activeId, allOtters])

  const stopStream = useCallback(() => {
    if (otterMsgIdRef.current) {
      api.abortMessage(otterMsgIdRef.current).catch((err) => console.error('Failed to abort message:', err))
    }
    sseCtrlRef.current?.abort()
    setStreaming(null)
  }, [])

  const handleSelectConv = useCallback((id: string) => { setActiveId(id); setPageState('normal') }, [])
  const handleNewConv = () => setModal({ type: 'new-conv' })
  const handleCreateChild = () => activeId && setModal({ type: 'child', parentId: activeId })
  const handleComplete = () => activeId && setModal({ type: 'complete', cid: activeId })
  const handleArchive = () => activeId && setModal({ type: 'archive', cid: activeId })

  const handleContextMenu = (e: React.MouseEvent, cid: string) => {
    e.preventDefault()
    const x = Math.min(e.clientX, window.innerWidth - 168)
    const y = Math.min(e.clientY, window.innerHeight - 138)
    setCtxMenu({ x, y, cid })
  }
  function closeCtxMenu() { setCtxMenu(null) }

  async function confirmNewConv(title: string) {
    try {
      const bigOtterId = allOtters[0]?.id
      const dto = await api.createConversation({ title, otterIds: bigOtterId ? [bigOtterId] : undefined })
      const conv = mapConversationDTO({ ...dto, otterIds: bigOtterId ? [bigOtterId] : [] })
      setConversations(prev => [conv, ...prev])
      setAllMessages(prev => ({ ...prev, [conv.id]: [] }))
      setActiveId(conv.id)
      setModal({ type: 'none' })
      showToast('对话已创建', 'success')
    } catch { showToast('创建对话失败', 'error') }
  }

  async function confirmChild(title: string) {
    if (modal.type !== 'child') return
    try {
      const bigOtterId = allOtters[0]?.id
      const dto = await api.createConversation({ title, otterIds: bigOtterId ? [bigOtterId] : undefined })
      const conv = mapConversationDTO({ ...dto, otterIds: bigOtterId ? [bigOtterId] : [] })
      setConversations(prev => [...prev, conv])
      setAllMessages(prev => ({ ...prev, [conv.id]: [] }))
      setActiveId(conv.id)
      setModal({ type: 'none' })
      showToast('子对话已创建', 'success')
    } catch { showToast('创建子对话失败', 'error') }
  }

  async function confirmComplete() {
    if (!activeId) return
    try {
      await api.completeConversation(activeId)
      setConversations(prev => prev.map(c => c.id === activeId ? { ...c, status: 'completed' as const } : c))
      setModal({ type: 'none' }); showToast('对话已完成', 'success')
    } catch { showToast('操作失败', 'error') }
  }

  async function confirmArchive() {
    if (!activeId) return
    try {
      await api.archiveConversation(activeId)
      setConversations(prev => prev.map(c => c.id === activeId ? { ...c, status: 'archived' as const } : c))
      setModal({ type: 'none' }); showToast('对话已归档', 'success')
    } catch { showToast('操作失败', 'error') }
  }

  async function confirmCreateOtter(name: string, role: string, resp: string[]) {
    if (!activeId) return
    try {
      const ci = (ciCounter.current % 4) + 1; ciCounter.current++
      const dto = await api.createOtter({
        name, type: 'small',
        role: { name: role, responsibilities: resp },
        parentOtterId: allOtters[0]?.id,
        systemPrompt: `你是${name}，角色：${role}。职责：${resp.join('、')}`,
      })
      const otter = mapOtterDTO(dto, ci)
      setAllOtters(prev => [...prev, otter])
      setConversations(prev => prev.map(c =>
        c.id === activeId ? { ...c, otterIds: [...c.otterIds, otter.id] } : c
      ))
      setModal({ type: 'none' }); showToast(`小獭 ${name} 已创建`, 'success')
    } catch { showToast('创建小獭失败', 'error') }
  }

  async function confirmDissolve(summary: string) {
    if (modal.type !== 'dissolve') return
    try {
      await api.dissolveOtter(modal.otterId, summary)
      setAllOtters(prev => prev.filter(o => o.id !== modal.otterId))
      setConversations(prev => prev.map(c => ({ ...c, otterIds: c.otterIds.filter(id => id !== modal.otterId) })))
      setModal({ type: 'none' }); showToast('小獭已解散', 'success')
    } catch { showToast('解散失败', 'error') }
  }

  async function confirmRestart(summary: string) {
    if (modal.type !== 'restart') return
    try {
      await api.restartOtter(modal.otterId, summary)
      setModal({ type: 'none' }); showToast('Session 已封存，新 Session 已开始', 'success')
    } catch { showToast('重启失败', 'error') }
  }

  async function confirmLinkResource(type: string, url: string, title: string) {
    if (!activeId) return
    try {
      const dto = await api.linkResource(activeId, {
        resourceType: type || 'url', url, title, linkedBy: 'user', autoLinked: false,
      })
      setAllLinkedRes(prev => ({ ...prev, [activeId]: [...(prev[activeId] || []), mapLinkedResourceDTO(dto)] }))
      setModal({ type: 'none' }); showToast('资源已链接', 'success')
    } catch { showToast('链接失败', 'error') }
  }

  async function addKeyFact(content: string, category: string) {
    if (!activeId) return
    try {
      const dto = await api.addKeyFact(activeId, { content, category, createdBy: 'user' })
      setAllKeyFacts(prev => ({ ...prev, [activeId]: [...(prev[activeId] || []), mapKeyFactDTO(dto)] }))
      showToast('关键事实已添加', 'success')
    } catch { showToast('添加失败', 'error') }
  }

  async function toggleKeyFact(id: string) {
    if (!activeId) return
    const fact = allKeyFacts[activeId]?.find(f => f.id === id)
    if (!fact) return
    const newFlagged = !fact.flagged
    setAllKeyFacts(prev => ({
      ...prev,
      [activeId]: (prev[activeId] || []).map(f => f.id === id ? { ...f, flagged: newFlagged } : f),
    }))
    try {
      await api.flagKeyFact(activeId, id, newFlagged)
    } catch {
      showToast('标记失败', 'error')
      setAllKeyFacts(prev => ({
        ...prev,
        [activeId]: (prev[activeId] || []).map(f => f.id === id ? { ...f, flagged: !newFlagged } : f),
      }))
    }
  }

  async function deleteKeyFact(id: string) {
    if (!activeId) return
    try {
      await api.deleteKeyFact(activeId, id)
      setAllKeyFacts(prev => ({ ...prev, [activeId]: (prev[activeId] || []).filter(f => f.id !== id) }))
    } catch { showToast('删除失败', 'error') }
  }

  async function deleteLinkedResource(id: string) {
    if (!activeId) return
    try {
      await api.deleteLinkedResource(activeId, id)
      setAllLinkedRes(prev => ({ ...prev, [activeId]: (prev[activeId] || []).filter(r => r.id !== id) }))
    } catch { showToast('删除失败', 'error') }
  }

  function ctxAction(action: string, cid: string) {
    closeCtxMenu(); setActiveId(cid)
    if (action === 'complete') setModal({ type: 'complete', cid })
    if (action === 'archive') setModal({ type: 'archive', cid })
    if (action === 'child') setModal({ type: 'child', parentId: cid })
  }

  const activeConvForMenu = ctxMenu ? conversations.find(c => c.id === ctxMenu.cid) : null

  if (pageState === 'loading') {
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

  return (
    <AppLayout activeView="conversation">
      <div className="flex flex-1 overflow-hidden p-3 gap-3">
        <LeftPanel conversations={conversations} activeId={activeId || ''} onSelect={handleSelectConv} onNewConversation={handleNewConv} onContextMenu={handleContextMenu} otters={allOtters} />
        <ChatView conversation={activeConv} messages={activeMessages} streamingMessage={streaming} state={pageState} onSend={handleSend} onStopStream={stopStream} onRetry={() => { setPageState('normal'); showToast('正在重试...', 'info') }} onGoToSettings={() => { window.location.href = '/settings' }} onCreateChild={handleCreateChild} onComplete={handleComplete} onArchive={handleArchive} otters={allOtters} />
        <RightPanel conversation={activeConv || conversations[0]} otters={activeOtters} sessions={sessions} keyFacts={activeKeyFacts} linkedResources={activeLinkedRes} onCreateSmallOtter={() => setModal({ type: 'create-otter' })} onDissolveOtter={(oid) => setModal({ type: 'dissolve', otterId: oid })} onRestartOtter={(oid) => setModal({ type: 'restart', otterId: oid })} onOpenOtterDetail={(oid) => setModal({ type: 'otter-detail', otterId: oid })} onAddKeyFact={addKeyFact} onToggleKeyFact={toggleKeyFact} onDeleteKeyFact={deleteKeyFact} onAddLinkedResource={() => setModal({ type: 'link-resource' })} onDeleteLinkedResource={deleteLinkedResource} />
      </div>

      {ctxMenu && activeConvForMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeCtxMenu} />
          <div className="fixed glass-strong rounded-2xl shadow-otter-lg p-1 z-50 min-w-[150px]" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <div onClick={() => ctxAction('complete', ctxMenu.cid)} className={`px-2.5 py-1.5 rounded-lg text-xs cursor-pointer ${activeConvForMenu.status === 'active' ? 'hover:bg-white/40 text-stone-600' : 'text-stone-300 cursor-not-allowed'}`}>完成对话</div>
            <div onClick={() => ctxAction('archive', ctxMenu.cid)} className={`px-2.5 py-1.5 rounded-lg text-xs cursor-pointer ${activeConvForMenu.status !== 'archived' ? 'hover:bg-white/40 text-stone-600' : 'text-stone-300 cursor-not-allowed'}`}>归档对话</div>
            <div onClick={() => ctxAction('child', ctxMenu.cid)} className="px-2.5 py-1.5 rounded-lg text-xs cursor-pointer hover:bg-white/40 text-stone-600">创建子对话</div>
          </div>
        </>
      )}

      <ConversationModals modal={modal} otters={allOtters} sessions={sessions} onClose={() => setModal({ type: 'none' })} onConfirmNewConv={confirmNewConv} onConfirmChild={confirmChild} onConfirmComplete={confirmComplete} onConfirmArchive={confirmArchive} onConfirmCreateOtter={confirmCreateOtter} onConfirmDissolve={confirmDissolve} onConfirmRestart={confirmRestart} onConfirmLinkResource={confirmLinkResource} onOpenRestart={(oid) => setModal({ type: 'restart', otterId: oid })} onOpenDissolve={(oid) => setModal({ type: 'dissolve', otterId: oid })} />
    </AppLayout>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<ConversationPage />)
