import { useState, useRef, useCallback, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import '../../styles/globals.css'

import type { LocalOtter, LocalConversation, LocalMessage, LocalLinkedResource, LocalOtterSession, LocalScheduledTask } from '../../lib/mappers'
import { mapOtterDTO, mapConversationDTO, mapMessageDTO, mapLinkedResourceDTO, mapSessionDTO } from '../../lib/mappers'
import { nowTs } from '../../lib/utils'
import { AppLayout } from '../../components/AppLayout'
import { showToast } from '../../components/Toast'
import { LeftPanel } from './LeftPanel'
import { ChatView } from './ChatView'
import { RightPanel } from './RightPanel'
import { ConversationModals, type ModalState } from './Modals'
import { ScheduledTaskModal } from './ScheduledTaskModal'
import { ExecutionHistoryModal } from './ExecutionHistoryModal'
import { useScheduledTasks } from './hooks/useScheduledTasks'
import type { StreamingState } from './MessageList'
import * as api from '../../api/client'
import { consumeSSE } from '../../api/sse'

async function loadInitialData(): Promise<{
  conversations: LocalConversation[]
}> {
  const convDTOs = await api.listConversations()
  const conversations = convDTOs.map(mapConversationDTO)
  return { conversations }
}

function ConversationPage() {
  const [conversations, setConversations] = useState<LocalConversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [allMessages, setAllMessages] = useState<Record<string, LocalMessage[]>>({})
  const [allOtters, setAllOtters] = useState<LocalOtter[]>([])
  const [sessions, setSessions] = useState<Record<string, LocalOtterSession[]>>({})
  const [allLinkedRes, setAllLinkedRes] = useState<Record<string, LocalLinkedResource[]>>({})
  const [modal, setModal] = useState<ModalState>({ type: 'none' })
  const [streamingMap, setStreamingMap] = useState<Map<string, StreamingState>>(new Map())
  const [pageState, setPageState] = useState<'normal' | 'empty' | 'loading' | 'error' | 'no-llm'>('loading')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; cid: string } | null>(null)

  // 定时任务状态
  const [scheduledTaskModal, setScheduledTaskModal] = useState<{
    type: 'none' | 'create' | 'edit'
    task?: LocalScheduledTask
  }>({ type: 'none' })
  const [executionHistoryTaskId, setExecutionHistoryTaskId] = useState<string | null>(null)

  const sseCtrlRef = useRef<AbortController | null>(null)
  const streamingMapRef = useRef<Map<string, StreamingState>>(new Map())
  const ciCounter = useRef(1)

  /** 同步 streamingMap 到 ref（SSE 闭包内需要读取最新状态） */
  useEffect(() => { streamingMapRef.current = streamingMap }, [streamingMap])

  // 定时任务 Hook
  const {
    tasks: scheduledTasks,
    loading: scheduledTasksLoading,
    toggleStatus: toggleScheduledTaskStatus,
    create: createScheduledTask,
    update: updateScheduledTask,
    remove: deleteScheduledTask,
    trigger: triggerScheduledTask,
  } = useScheduledTasks(activeId)

  useEffect(() => {
    loadInitialData()
      .then(({ conversations: convs }) => {
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
      const [msgs, keyInfo, participants] = await Promise.all([
        api.listMessages(convId, 100),
        api.getKeyResources(convId),
        api.getParticipants(convId),
      ])
      /**   events 已嵌入 messages 响应，无需额外请求 */
      const mapped = msgs.map((msg) => {
        const local = mapMessageDTO(msg)
        if (local.st === 'otter' && msg.events && msg.events.length > 0) {
          local.events = msg.events.map((e: { eventType: string; payload: Record<string, unknown> }) => ({
            eventType: e.eventType,
            payload: e.payload,
          }))
        }
        return local
      })
      setAllMessages(prev => ({
        ...prev,
        [convId]: mapped.reverse(),
      }))
      setAllLinkedRes(prev => ({
        ...prev,
        [convId]: keyInfo.resources.map(mapLinkedResourceDTO),
      }))
      // 更新 allOtters，添加对话中的 otter
      setAllOtters(prev => {
        const existingIds = new Set(prev.map(o => o.id))
        const newOtters = participants
          .filter(p => !existingIds.has(p.otterId))
          .map(p => ({ id: p.otterId, name: p.otterName, ci: 0 }))
        return [...prev, ...newOtters]
      })
    } catch (err) {
      console.error('Failed to load conversation detail:', err)
      showToast('加载对话详情失败', 'error')
    }
  }, [])

  useEffect(() => {
    if (activeId && !allMessages[activeId]) {
      loadConversationDetail(activeId)
    }
  }, [activeId, allMessages, loadConversationDetail])

  useEffect(() => {
    for (const otter of allOtters) {
      if (!sessions[otter.id]) {
        api.getSessionHistory(otter.id)
          .then(dtos => setSessions(prev => ({ ...prev, [otter.id]: dtos.map(mapSessionDTO) })))
          .catch(err => console.error(`Failed to load sessions for otter ${otter.id}:`, err))
      }
    }
  }, [allOtters, sessions])

  const activeConv = conversations.find(c => c.id === activeId) || null
  const activeMessages = activeId ? (allMessages[activeId] || []) : []
  const activeLinkedRes = activeId ? (allLinkedRes[activeId] || []) : []
  const activeOtters: LocalOtter[] = (activeConv?.otterIds || [])
    .map(id => allOtters.find(o => o.id === id))
    .filter((o): o is LocalOtter => o !== undefined)

  const handleSend = useCallback(async (text: string, mentionOtterId?: string) => {
    if (!activeId) return
    const targetOtterIds = mentionOtterId
      ? [mentionOtterId]
      : activeOtters.map(o => o.id)
    if (targetOtterIds.length === 0) { showToast('没有可用的 Otter', 'error'); return }

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
        senderId: 'user', talkingStonePassedTo: targetOtterIds, body: text,
      })
      if (!response.ok) { showToast('发送失败', 'error'); return }

      const startTime = Date.now()
      /** 按 messageId 隔离的 liveEvents（每个 otter 独立） */
      const liveEventsMap = new Map<string, Array<{ eventType: string; payload: Record<string, unknown> }>>()

      const ctrl = consumeSSE(response, {
        'message.start': (data) => {
          const { messageId, otterId } = data
          liveEventsMap.set(messageId, [])
          setStreamingMap(prev => new Map(prev).set(messageId, {
            messageId, otterId, duration: 0, events: [],
          }))
        },
        'assistant_toolcall': (data) => {
          const { messageId } = data
          const liveEvents = liveEventsMap.get(messageId)
          if (!liveEvents) return
          liveEvents.push({ eventType: 'assistant_toolcall', payload: { content: data.content } })
          setStreamingMap(prev => {
            const entry = prev.get(messageId)
            if (!entry) return prev
            const next = new Map(prev)
            next.set(messageId, { ...entry, events: [...liveEvents], duration: (Date.now() - startTime) / 1000 })
            return next
          })
        },
        'tool.result': (data) => {
          const { messageId } = data
          const liveEvents = liveEventsMap.get(messageId)
          if (!liveEvents) return
          liveEvents.push({ eventType: 'tool_result', payload: { name: data.toolName, result: data.result } })
          setStreamingMap(prev => {
            const entry = prev.get(messageId)
            if (!entry) return prev
            const next = new Map(prev)
            next.set(messageId, { ...entry, events: [...liveEvents], duration: (Date.now() - startTime) / 1000 })
            return next
          })
        },
        'assistant_text': (data) => {
          const { messageId } = data
          const liveEvents = liveEventsMap.get(messageId)
          if (!liveEvents) return
          liveEvents.push({ eventType: 'assistant_text', payload: { content: data.content } })
          setStreamingMap(prev => {
            const entry = prev.get(messageId)
            if (!entry) return prev
            const next = new Map(prev)
            next.set(messageId, { ...entry, events: [...liveEvents], duration: (Date.now() - startTime) / 1000 })
            return next
          })
        },
        'message.complete': (data) => {
          const { messageId } = data
          const liveEvents = liveEventsMap.get(messageId) || []
          const streamingEntry = streamingMapRef.current.get(messageId)
          const otterId = streamingEntry?.otterId || ''
          /** body 来自 SSE 事件（后端 speak 完成后从 DB 取出），与 assistant_text 事件无关 */
          const finalMsg: LocalMessage = {
            id: messageId, st: 'otter', si: otterId,
            content: data.body ?? '', ts: nowTs(), dur: data.duration,
            events: liveEvents.length > 0 ? liveEvents : undefined,
            ctx: data.ctx, ctxMax: data.ctxMax,
          }
          setAllMessages(prev => ({ ...prev, [activeId]: [...(prev[activeId] || []), finalMsg] }))
          liveEventsMap.delete(messageId)
          setStreamingMap(prev => { const next = new Map(prev); next.delete(messageId); return next })
        },
        'error': (data) => {
          const { messageId, otterId } = data
          const errMsg: LocalMessage = {
            id: messageId || crypto.randomUUID(), st: 'otter', si: otterId || 'unknown',
            content: `[错误] ${data.message}`, ts: nowTs(), dur: null,
          }
          setAllMessages(prev => ({ ...prev, [activeId]: [...(prev[activeId] || []), errMsg] }))
          showToast(`Agent 错误: ${data.message}`, 'error')
          if (messageId) {
            liveEventsMap.delete(messageId)
            setStreamingMap(prev => { const next = new Map(prev); next.delete(messageId); return next })
          }
        },
        'message.aborted': (data) => {
          showToast('回复已中断', 'info')
          liveEventsMap.delete(data.messageId)
          setStreamingMap(prev => { const next = new Map(prev); next.delete(data.messageId); return next })
        },
        'message.failed': (data) => {
          /** 失败消息：body 来自 SSE 事件（服务端 sendMessage.fail 存储的失败原因） */
          const { messageId } = data
          const liveEvents = liveEventsMap.get(messageId) || []
          const streamingEntry = streamingMapRef.current.get(messageId)
          const otterId = streamingEntry?.otterId || ''
          const failedMsg: LocalMessage = {
            id: messageId, st: 'otter', si: otterId,
            content: data.body ?? '[未完成]', ts: nowTs(), dur: null,
            events: liveEvents.length > 0 ? liveEvents : undefined,
          }
          setAllMessages(prev => ({ ...prev, [activeId]: [...(prev[activeId] || []), failedMsg] }))
          liveEventsMap.delete(messageId)
          setStreamingMap(prev => { const next = new Map(prev); next.delete(messageId); return next })
        },
        'system.message': (data) => {
          const sysMsg: LocalMessage = {
            id: data.messageId, st: 'system', si: 'system',
            content: data.content, ts: nowTs(), dur: null,
          }
          setAllMessages(prev => ({ ...prev, [activeId]: [...(prev[activeId] || []), sysMsg] }))
        },
        'agent.idle': () => { /* 信息性事件，不做处理 */ },
      }, { onError: () => {
        showToast('SSE 连接中断', 'error')
        setStreamingMap(new Map())
      }, onDone: () => {
        /** 流结束后刷新参与者列表（agent 可能创建/解散了小獭） */
        if (activeId) {
          api.getParticipants(activeId).then(participants => {
            setAllOtters(prev => {
              const existingIds = new Set(prev.map(o => o.id))
              const newOtters = participants
                .filter(p => !existingIds.has(p.otterId))
                .map(p => ({ id: p.otterId, name: p.otterName, ci: 0 }))
              return newOtters.length > 0 ? [...prev, ...newOtters] : prev
            })
          }).catch(() => {})
        }
      } })
      sseCtrlRef.current = ctrl
    } catch (err) {
      console.error('Failed to send message:', err)
      showToast('发送失败', 'error'); setStreamingMap(new Map())
    }
  }, [activeId, activeOtters])

  const stopStream = useCallback((messageId: string) => {
    api.abortMessage(messageId).catch((err) => console.error('Failed to abort message:', err))
    setStreamingMap(prev => { const next = new Map(prev); next.delete(messageId); return next })
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
      const dto = await api.createConversation({ title })
      const conv = mapConversationDTO(dto)
      setConversations(prev => [conv, ...prev])
      setActiveId(conv.id)
      setModal({ type: 'none' })
      showToast('对话已创建', 'success')
      await loadConversationDetail(conv.id)
    } catch { showToast('创建对话失败', 'error') }
  }

  async function confirmChild(title: string) {
    if (modal.type !== 'child') return
    try {
      const dto = await api.createConversation({ title })
      const conv = mapConversationDTO(dto)
      setConversations(prev => [...prev, conv])
      setActiveId(conv.id)
      setModal({ type: 'none' })
      showToast('子对话已创建', 'success')
      await loadConversationDetail(conv.id)
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

  async function addFact(content: string, category: string) {
    if (!activeId) return
    try {
      const dto = await api.linkResource(activeId, { resourceType: 'fact', content, category, linkedBy: 'user', autoLinked: false })
      setAllLinkedRes(prev => ({ ...prev, [activeId]: [...(prev[activeId] || []), mapLinkedResourceDTO(dto)] }))
      showToast('关键事实已添加', 'success')
    } catch { showToast('添加失败', 'error') }
  }

  async function toggleResourceFlag(id: string) {
    if (!activeId) return
    const res = allLinkedRes[activeId]?.find(r => r.id === id)
    if (!res) return
    const newFlagged = !res.flagged
    setAllLinkedRes(prev => ({
      ...prev,
      [activeId]: (prev[activeId] || []).map(r => r.id === id ? { ...r, flagged: newFlagged } : r),
    }))
    try {
      await api.flagResource(activeId, id, newFlagged)
    } catch {
      showToast('标记失败', 'error')
      setAllLinkedRes(prev => ({
        ...prev,
        [activeId]: (prev[activeId] || []).map(r => r.id === id ? { ...r, flagged: !newFlagged } : r),
      }))
    }
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
        <ChatView conversation={activeConv} messages={activeMessages} streamingMessages={streamingMap} state={pageState} onSend={handleSend} onStopStream={stopStream} onRetry={() => { setPageState('normal'); showToast('正在重试...', 'info') }} onGoToSettings={() => { window.location.href = '/settings' }} onCreateChild={handleCreateChild} onComplete={handleComplete} onArchive={handleArchive} otters={allOtters} />
        <RightPanel
          conversation={activeConv || conversations[0]}
          otters={activeOtters}
          sessions={sessions}
          linkedResources={activeLinkedRes}
          onCreateSmallOtter={() => setModal({ type: 'create-otter' })}
          onDissolveOtter={(oid) => setModal({ type: 'dissolve', otterId: oid })}
          onRestartOtter={(oid) => setModal({ type: 'restart', otterId: oid })}
          onOpenOtterDetail={(oid) => setModal({ type: 'otter-detail', otterId: oid })}
          onAddFact={addFact}
          onToggleResourceFlag={toggleResourceFlag}
          onAddLinkedResource={() => setModal({ type: 'link-resource' })}
          onDeleteLinkedResource={deleteLinkedResource}
          // 定时任务 props
          scheduledTasks={scheduledTasks}
          scheduledTasksLoading={scheduledTasksLoading}
          onToggleScheduledTask={toggleScheduledTaskStatus}
          onCreateScheduledTask={() => setScheduledTaskModal({ type: 'create' })}
          onEditScheduledTask={(task) => setScheduledTaskModal({ type: 'edit', task })}
          onDeleteScheduledTask={async (taskId) => {
            if (confirm('确定要删除这个定时任务吗？')) {
              await deleteScheduledTask(taskId)
            }
          }}
          onTriggerScheduledTask={triggerScheduledTask}
          onViewScheduledTaskHistory={(taskId) => setExecutionHistoryTaskId(taskId)}
        />
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

      {/* 定时任务 Modal */}
      {scheduledTaskModal.type !== 'none' && (
        <ScheduledTaskModal
          mode={scheduledTaskModal.type === 'create' ? 'create' : 'edit'}
          task={scheduledTaskModal.task}
          otters={activeOtters}
          onSave={async (data) => {
            if (scheduledTaskModal.type === 'create') {
              await createScheduledTask(data)
            } else if (scheduledTaskModal.task) {
              await updateScheduledTask(scheduledTaskModal.task.id, data)
            }
            setScheduledTaskModal({ type: 'none' })
          }}
          onClose={() => setScheduledTaskModal({ type: 'none' })}
        />
      )}

      {/* 执行历史 Modal */}
      {executionHistoryTaskId && (
        <ExecutionHistoryModal
          taskId={executionHistoryTaskId}
          onClose={() => setExecutionHistoryTaskId(null)}
          onJumpToMessage={(messageId) => {
            // 滚动到消息
            const el = document.getElementById(`msg-${messageId}`)
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' })
              el.classList.add('highlight-message')
              setTimeout(() => el.classList.remove('highlight-message'), 2000)
            }
          }}
        />
      )}
    </AppLayout>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<ConversationPage />)
