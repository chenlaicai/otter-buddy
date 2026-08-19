import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import '../../styles/globals.css'

import type { LocalOtter, LocalConversation, LocalMessage, LocalLinkedResource, LocalOtterSession, LocalScheduledTask } from '../../lib/mappers'
import { mapOtterDTO, mapConversationDTO, mapMessageDTO, mapLinkedResourceDTO, mapSessionDTO, mapParticipantDTO } from '../../lib/mappers'
import { isInFlight, upsertMessage, insertBySeq, findStaleInFlight, upsertTerminalMessage } from '../../lib/message-stream'
import { MessageBatcher } from '../../lib/batch-update'
import { nowTs } from '../../lib/utils'
import { AppLayout } from '../../components/AppLayout'
import { showToast } from '../../components/Toast'
import { LeftPanel } from './LeftPanel'
import { ChatView } from './ChatView'
import { RightPanel } from './RightPanel'
import { ConversationModals, type ModalState } from './Modals'
import { useConversationListPolling } from '../../hooks/use-conversation-list-polling'
import { ScheduledTaskModal } from './ScheduledTaskModal'
import { ExecutionHistoryModal } from './ExecutionHistoryModal'
import { useScheduledTasks } from './hooks/useScheduledTasks'
import { useCardBridge } from './hooks/useCardBridge'
import * as api from '../../api/client'
import { ApiError } from '../../api/client'
import { consumeSSE } from '../../api/sse'
import { type MessageDTO } from '@contract/api'

async function loadInitialData(): Promise<{
  conversations: LocalConversation[]
}> {
  const convDTOs = await api.listConversations()
  const conversations = convDTOs.map(mapConversationDTO)
  return { conversations }
}

/** listMessages DTO → LocalMessage（events 已嵌入响应，无需额外请求） */
function mapMessageDTOs(msgs: MessageDTO[]): LocalMessage[] {
  return msgs.map((msg) => {
    const local = mapMessageDTO(msg)
    if (local.st === 'otter' && msg.events && msg.events.length > 0) {
      local.events = msg.events.map((e: { eventType: string; payload: Record<string, unknown>; createdAt?: string }) => ({
        ts: e.createdAt || local.ts,
        eventType: e.eventType,
        payload: e.payload,
      }))
    }
    return local
  }).reverse()
}

/** MessageDTO[] -> LocalMessage[]（核心映射，不反转；用于 after 分页返回的 ASC 数据） */
function mapMessagesCore(msgs: MessageDTO[]): LocalMessage[] {
  return msgs.map((msg) => {
    const local = mapMessageDTO(msg)
    if (local.st === 'otter' && msg.events && msg.events.length > 0) {
      local.events = msg.events.map((e: { eventType: string; payload: Record<string, unknown>; createdAt?: string }) => ({
        ts: e.createdAt || local.ts,
        eventType: e.eventType,
        payload: e.payload,
      }))
    }
    return local
  })
}


function ConversationPage() {
  const [conversations, setConversations] = useState<LocalConversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [allMessages, setAllMessages] = useState<Record<string, LocalMessage[]>>({})
  const [allOtters, setAllOtters] = useState<Record<string, LocalOtter[]>>({})
  const [sessions, setSessions] = useState<Record<string, LocalOtterSession[]>>({})
  const [allLinkedRes, setAllLinkedRes] = useState<Record<string, LocalLinkedResource[]>>({})
  const [modal, setModal] = useState<ModalState>({ type: 'none' })
  const [pageState, setPageState] = useState<'normal' | 'empty' | 'loading' | 'error' | 'no-llm'>('loading')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; cid: string } | null>(null)

  // 滚动状态
  const isAtBottomRef = useRef(true)
  const [newMessagesCount, setNewMessagesCount] = useState(0)
  // 双向分页状态
  const [hasMoreBefore, setHasMoreBefore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingMoreRef = useRef(false)
  // 未读状态
  const [, setUnreadState] = useState<{ lastReadSeq: number; unreadCount: number; firstUnreadMessageId: string | null; firstUnreadSeq: number | null } | null>(null)
  const [unreadSeparatorSeq, setUnreadSeparatorSeq] = useState<number | null>(null)
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null)
  /** 用户在设置中配置的称呼，用于消息气泡旁的名称显示 */
  const [userName, setUserName] = useState('')
  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** abort toast 同步去重（F20260805abpp 第三轮检视 S-1）：发送流与常驻通道共享广播总线，
   *  message.aborted 会双通道投递；不能用 updater 闭包标志——React 有 pending update 时
   *  updater 延迟执行，同步读取恒为 false（零 toast）。ref Set 绕开调度时序 */
  const abortNotifiedRef = useRef<Set<string>>(new Set())
  const allMessagesRef = useRef<Record<string, LocalMessage[]>>({})
  // 同步 allMessages 到 ref，供回调函数读取（解除闭包依赖）
  useEffect(() => {
    allMessagesRef.current = allMessages
  }, [allMessages])
  useEffect(() => () => {
    if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current)
  }, [])

  // 批量更新机制：50ms 窗口内的 SSE 事件合并为一次 setAllMessages，减少消息列表重渲染
  // 选择依据：≥16ms 保证至少一帧合并，≤100ms 保证流式体感（人类感知延迟阈值约 100ms）
  // 50ms 是平衡点：既减少重渲染频率，又不明显影响流式文本的实时感
  // F20260814qswp：改为 MessageBatcher 暂存副本链式执行——旧实现在 setState updater 内
  // 执行业务 updater 且返回 prev，窗口内后续 updater 读到的是原始列表，中间更新丢失
  // F20260814qswp 三轮：materialize 在 setState 函数式 updater 内调用（prev=队列最新值），
  // 消除 allMessagesRef 镜像在 commit→passive-effect 间隙的引用比较盲区
  const BATCH_WINDOW_MS = 50
  const batcher = useMemo(() => new MessageBatcher({
    windowMs: BATCH_WINDOW_MS,
    getBase: (convId) => allMessagesRef.current[convId] ?? [],
    apply: (updates) => {
      setAllMessages(prev => {
        let next: Record<string, LocalMessage[]> | null = null
        for (const [convId, materialize] of updates) {
          const result = materialize(prev[convId])
          if (result === prev[convId]) continue
          next = next ?? { ...prev }
          next[convId] = result
        }
        return next ?? prev
      })
    },
  }), [])
  useEffect(() => () => {
    batcher.dispose()
  }, [batcher])
  const batchUpdateMessages = useCallback((convId: string, updater: (prev: LocalMessage[]) => LocalMessage[]) => {
    batcher.update(convId, updater)
  }, [batcher])

  // 从 URL 路径获取对话 ID（格式：/conversation/:id）
  const pathParts = window.location.pathname.split('/')
  const urlConvId = pathParts.length >= 3 && pathParts[1] === 'conversation' ? pathParts[2] : null

  // 定时任务状态
  const [scheduledTaskModal, setScheduledTaskModal] = useState<{
    type: 'none' | 'create' | 'edit'
    task?: LocalScheduledTask
  }>({ type: 'none' })
  const [executionHistoryTaskId, setExecutionHistoryTaskId] = useState<string | null>(null)

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

  /** dissolve_otter 工具执行完成后刷新参与者列表（DRY 提取，检视獭 review F1） */
  const refreshParticipantsAfterDissolve = useCallback((toolName: string) => {
    if (toolName !== 'dissolve_otter' || !activeId) return
    api.getParticipants(activeId).then(participants => {
      setAllOtters(prev => ({
        ...prev,
        [activeId]: participants.map(p => mapParticipantDTO(p)),
      }))
    }).catch(err => console.error('Failed to refresh participants after dissolve:', err))
  }, [activeId])

  useEffect(() => {
    loadInitialData()
      .then(({ conversations: convs }) => {
        setConversations(convs)
        if (convs.length > 0) {
          // 优先使用 URL 中的对话 ID，否则使用第一个对话
          const targetId = urlConvId && convs.some(c => c.id === urlConvId) ? urlConvId : convs[0].id
          setActiveId(targetId)
          setPageState('normal')
        } else {
          setPageState('empty')
        }
      })
      .catch(() => setPageState('error'))

    // 获取用户设置（用于消息气泡旁的名称显示）
    api.getSettings()
      .then(s => setUserName(s.userName ?? ''))
      .catch(() => console.warn('[ConversationPage] Failed to load userName setting'))
  }, [])

  // 活动状态轮询：每 5 秒刷新对话列表（仅在页面可见时）
  useConversationListPolling(pageState !== 'loading' && pageState !== 'error', setConversations)

  const loadConversationDetail = useCallback(async (convId: string) => {
    try {
      const [listResp, keyInfo, participants] = await Promise.all([
        api.listMessages(convId, 100),
        api.getKeyResources(convId),
        api.getParticipants(convId),
      ])
      // 未读状态独立加载，失败不阻塞会话展示（降级为无未读）
      const unread = await api.getUnreadState(convId).catch(() => ({
        lastReadSeq: 0, unreadCount: 0, firstUnreadMessageId: null, firstUnreadSeq: null,
      }))
      let msgs = mapMessageDTOs(listResp.messages)
      setHasMoreBefore(listResp.hasMore)
      setUnreadState(unread)
      // 首次访问（无已读记录）：初始化已读到最新，避免下次进入显示全部未读
      if (unread.lastReadSeq === 0 && unread.unreadCount === 0 && msgs.length > 0) {
        const maxSeq = msgs[msgs.length - 1]?.seq
        if (maxSeq != null) api.markRead(convId, maxSeq).catch(() => {})
      }
      setUnreadSeparatorSeq(null)
      // 未读定位：第一条未读消息
      if (unread.firstUnreadSeq != null && unread.firstUnreadMessageId) {
        const unreadIdx = msgs.findIndex(m => m.seq === unread.firstUnreadSeq)
        if (unreadIdx >= 0) {
          setUnreadSeparatorSeq(unread.firstUnreadSeq)
        } else {
          // 未读不在窗口（大量未读）：expand 加载未读附近
          const expanded = await api.expandMessage(unread.firstUnreadMessageId, 'both', 25)
          msgs = mapMessagesCore(expanded)
          setHasMoreBefore(true)
          setUnreadSeparatorSeq(unread.firstUnreadSeq)
        }
      }
      setAllMessages(prev => ({
        ...prev,
        [convId]: msgs,
      }))
      setAllLinkedRes(prev => ({
        ...prev,
        [convId]: keyInfo.resources.map(mapLinkedResourceDTO),
      }))
      // 更新 allOtters，按对话存储
      setAllOtters(prev => ({
        ...prev,
        [convId]: participants.map(p => mapParticipantDTO(p)),
      }))
    } catch (err) {
      console.error('Failed to load conversation detail:', err)
      showToast('加载对话详情失败', 'error')
    }
  }, [])

  /** 静默刷新消息列表（轮询用，失败不打扰用户，下轮重试） */
  /** 增量刷新：只拉比当前最新消息更新的消息（after 游标），不触碰 prepend 的历史 */
  const refreshMessages = useCallback(async (convId: string) => {
    try {
      const list = allMessagesRef.current[convId] || []
      const realMsgs = list.filter(m => !m.id.startsWith('tmp-') && !m.id.startsWith('err-'))
      const newest = realMsgs[realMsgs.length - 1]
      if (!newest?.id) return
      const resp = await api.listMessagesAfter(convId, newest.id, 100)
      const newerMsgs = mapMessagesCore(resp.messages) // ASC
      if (newerMsgs.length > 0) {
        setAllMessages(prev => {
          const current = prev[convId] || []
          let merged = current
          for (const msg of newerMsgs) {
            merged = insertBySeq(merged, msg) // 同 id 替换（in-flight 终态），新消息按 seq 有序插入
          }
          return { ...prev, [convId]: merged }
        })
      }
      /** 增量结果未含的 in-flight 消息：定点拉取收敛（SSE 断连兜底）。
       *  不能在增量为空时提前返回——in-flight 恰好是最新消息时 /after 恒为空，
       *  其状态迁移（streaming→aborted/completed）只能靠定点拉取收敛（F20260805abpp） */
      const outOfWindow = findStaleInFlight(list, new Set(newerMsgs.map(m => m.id)))
      for (const m of outOfWindow) {
        try {
          const serverMsg = mapMessageDTO(await api.getMessage(m.id))
          setAllMessages(prev => {
            const l = prev[convId]
            const existing = l?.find(x => x.id === m.id)
            if (!existing) return prev
            /** 仍在生成且内容未变：跳过替换，避免引用抖动触发轮询 effect 空转重排 */
            if (existing.status === serverMsg.status && existing.content === serverMsg.content) return prev
            return { ...prev, [convId]: l.map(x => x.id === m.id ? { ...serverMsg, events: m.events } : x) }
          })
        } catch { /* 下轮重试 */ }
      }
    } catch (err) {
      console.error('Failed to refresh messages:', err)
    }
  }, []) // 依赖为空，通过 allMessagesRef 读取最新值

  /** 点击"新消息 N 条"浮窗：滚到底部 + 清零计数 */
  const handleJumpToBottom = useCallback(() => {
    // 找到滚动容器，滚到底部
    const scrollEl = document.querySelector('[data-message-list]') as HTMLElement
    if (scrollEl) {
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' })
    }
    setNewMessagesCount(0)
  }, [])

  /** 向上加载更旧的历史消息（startReached 触发，before 游标） */
  const loadMoreBefore = useCallback(async () => {
    if (!activeId || loadingMoreRef.current || !hasMoreBefore) return
    const list = allMessagesRef.current[activeId] || []
    const oldest = list[0]
    if (!oldest?.id) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const resp = await api.listMessages(activeId, 50, oldest.id)
      if (resp.messages.length === 0) { setHasMoreBefore(false); return }
      const olderMsgs = mapMessageDTOs(resp.messages) // DESC -> 升序
      setHasMoreBefore(resp.hasMore)
      setAllMessages(prev => ({
        ...prev,
        [activeId]: [...olderMsgs, ...(prev[activeId] || [])],
      }))
    } catch (err) {
      console.error('Failed to load more history:', err)
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }, [activeId, hasMoreBefore]) // 依赖为空，通过 allMessagesRef 读取最新值



  /** 跳转到消息：已加载则滚动定位，未加载则 expand 加载后定位；高亮 2s */
  const handleJumpToMessage = useCallback((messageId: string) => {
    if (!activeId) return
    const msgs = allMessages[activeId] || []
    const targetIndex = msgs.findIndex(m => m.id === messageId)
    if (targetIndex >= 0) {
      // 找到目标消息的 DOM 元素，滚动到可视区域
      const msgEl = document.querySelector(`[data-message-id="${messageId}"]`)
      if (msgEl) {
        msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      setHighlightMessageId(messageId)
      setTimeout(() => setHighlightMessageId(null), 2000)
    }
  }, [activeId, allMessages])

  useEffect(() => {
    if (activeId && !allMessages[activeId]) {
      loadConversationDetail(activeId)
    }
  }, [activeId, allMessages, loadConversationDetail])

  /** 刷新页面后若有仍在生成的消息（SSE 已断），轮询续看直到全部进入终态。
   *  自续期（F20260805abpp）：空转（增量为空、状态未变）不改变 allMessages，
   *  若依赖 effect 重跑来排下一轮，轮询链在首次无变化后永久停转——故循环自我排期，
   *  直到 allMessages 变化触发重跑时由入口条件（是否仍有 in-flight）决定去留 */
  useEffect(() => {
    if (!activeId) return
    const msgs = allMessages[activeId]
    if (!msgs || !msgs.some(isInFlight)) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const scheduleNext = () => {
      timer = setTimeout(() => {
        void refreshMessages(activeId).finally(() => {
          if (!cancelled) scheduleNext()
        })
      }, 2000)
    }
    scheduleNext()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [activeId, allMessages, refreshMessages])

  /** 订阅消息广播（支持飞书消息实时同步到 Web，含 agent streaming 事件） */
  useEffect(() => {
    if (!activeId) return

    // streaming 生命周期状态
    const liveEventsMap = new Map<string, Array<{ ts: string; eventType: string; payload: Record<string, unknown> }>>()
    const liveMeta = new Map<string, { otterId: string; otterName?: string; createdAt: string }>()
    /** F20260814qswp 三轮：按 messageId 累积的流式文本。assistant_text 的 content 更新
     *  用"累积 + 全量 set"幂等语义（不再 content += text）——服务端 startSpeaking 在 speak
     *  开始即持久化全文，轮询快照会以全文替换 content；+= 语义（含 batcher 重放路径）在
     *  快照之上再追加会造成文本重复，set 语义天然幂等、重放/快照安全 */
    const liveText = new Map<string, string>()

    const syncLiveEvents = (messageId: string) => {
      const liveEvents = liveEventsMap.get(messageId)
      if (!liveEvents) return
      batchUpdateMessages(activeId!, (list) => {
        if (!list.some(m => m.id === messageId)) return list
        return list.map(m => m.id === messageId ? { ...m, events: [...liveEvents] } : m)
      })
    }

    // 事件分发器
    const handlers: Record<string, (data: Record<string, unknown>) => void> = {
      'message': (data) => {
        const message = mapMessageDTO(data as unknown as Parameters<typeof mapMessageDTO>[0])
        // MessageBatcher 的 updater 在 update() 调用时同步执行（F20260814qswp），added 在回调内设置、回调外读取是可靠的
        let added = false
        batchUpdateMessages(activeId!, (current) => {
          if (current.some(m => m.id === message.id)) return current
          // tmp 去重：乐观消息（tmp-）按 st|si|content 匹配后替换为真实消息
          const tmpIdx = current.findIndex(m => m.id.startsWith('tmp-') && m.st === message.st && m.si === message.si && m.content === message.content)
          if (tmpIdx >= 0) {
            const next = [...current]
            next[tmpIdx] = message
            return next
          }
          added = true
          return [...current, message]
        })
        // BUG-FIX: 仅在消息确实新增（非重复/去重替换）时计数，防止重复广播事件虚增
        if (added && !isAtBottomRef.current) setNewMessagesCount(c => c + 1)
      },
      'message.start': (data) => {
        const { messageId, otterId, otterName } = data as { messageId: string; otterId: string; otterName: string }
        liveEventsMap.set(messageId, [])
        liveMeta.set(messageId, { otterId, otterName, createdAt: (data.createdAt as string) || nowTs() })
        const placeholder: LocalMessage = {
          id: messageId, st: 'otter', si: otterId, sn: otterName,
          content: '', status: 'streaming', seq: data.seq as number, ts: (data.createdAt as string) || nowTs(), dur: null, events: [],
        }
        // MessageBatcher 的 updater 同步执行（同 message handler 的 added 模式）
        let added = false
        batchUpdateMessages(activeId!, (current) => {
          if (current.some(m => m.id === messageId)) return current
          added = true
          return insertBySeq(current, placeholder)
        })
        if (otterId && activeId) {
          setAllOtters(prev => {
            const convOtters = prev[activeId] || []
            if (convOtters.some(o => o.id === otterId)) return prev
            return { ...prev, [activeId]: [...convOtters, { id: otterId, name: otterName, type: 'small', createdAt: '' }] }
          })
        }
        if (added && !isAtBottomRef.current) setNewMessagesCount(c => c + 1)
      },
      'assistant_text': (data) => {
        const liveEvents = liveEventsMap.get(data.messageId as string)
        if (!liveEvents) return
        liveEvents.push({ ts: nowTs(), eventType: 'assistant_text', payload: { content: data.content } })
        syncLiveEvents(data.messageId as string)
        /** F20260819spyd：assistant 文本不再累积进气泡——speak 之外的输出不进入最终消息，
         *  且与 speak.intermediate 双通道累积会造成同内容重复渲染。
         *  气泡内容只由 speak.intermediate（真实落库内容的实时投影）累积。 */
      },
      'speak.intermediate': (data) => {
        const body = data.body as string
        if (!body) return
        const messageId = data.messageId as string
        const acc = (liveText.get(messageId) || '') + (liveText.has(messageId) ? '\n\n' : '') + body
        liveText.set(messageId, acc)
        batchUpdateMessages(activeId!, (list) => {
          if (!list.some(m => m.id === messageId)) return list
          return list.map(m => m.id === messageId ? { ...m, content: acc, sn: m.sn || (data as Record<string, unknown>).otterName as string || m.sn } : m)
        })
      },
      'assistant_toolcall': (data) => {
        const liveEvents = liveEventsMap.get(data.messageId as string)
        if (!liveEvents) return
        liveEvents.push({ ts: nowTs(), eventType: 'assistant_toolcall', payload: { content: data.content } })
        syncLiveEvents(data.messageId as string)
      },
      'tool.result': (data) => {
        const liveEvents = liveEventsMap.get(data.messageId as string)
        if (!liveEvents) return
        liveEvents.push({ ts: nowTs(), eventType: 'tool_result', payload: { name: data.toolName, result: data.result } })
        syncLiveEvents(data.messageId as string)
        refreshParticipantsAfterDissolve(data.toolName as string)
      },
      'message.complete': (data) => {
        const { messageId, otterId: dataOtterId, otterName: dataOtterName } = data as { messageId: string; otterId?: string; otterName?: string }
        const liveEvents = liveEventsMap.get(messageId) || []
        const meta = liveMeta.get(messageId)
        const finalMsg: LocalMessage = {
          id: messageId, st: 'otter', si: meta?.otterId || dataOtterId || '', sn: meta?.otterName || dataOtterName,
          content: (data.body as string) ?? '', status: 'completed', ts: meta?.createdAt || '', dur: data.duration as string,
          events: liveEvents.length > 0 ? liveEvents : undefined,
          ctx: data.ctx as number, ctxMax: data.ctxMax as number, turnId: (data.turnId as string) || undefined,
        }
        batchUpdateMessages(activeId!, (list) => upsertTerminalMessage(list, finalMsg))
        liveEventsMap.delete(messageId)
        liveMeta.delete(messageId)
        liveText.delete(messageId)
      },
      'message.failed': (data) => {
        const { messageId, otterId: dataOtterId, otterName: dataOtterName } = data as { messageId: string; otterId?: string; otterName?: string }
        const liveEvents = liveEventsMap.get(messageId) || []
        const meta = liveMeta.get(messageId)
        const failedMsg: LocalMessage = {
          id: messageId, st: 'otter', si: meta?.otterId || dataOtterId || '', sn: meta?.otterName || dataOtterName,
          content: (data.body as string) ?? '[未完成]', status: 'failed', ts: meta?.createdAt || '', dur: null,
          events: liveEvents.length > 0 ? liveEvents : undefined,
        }
        batchUpdateMessages(activeId!, (list) => upsertTerminalMessage(list, failedMsg))
        liveEventsMap.delete(messageId)
        liveMeta.delete(messageId)
        liveText.delete(messageId)
      },
      /** F20260805abpp：常驻通道必须处理 message.aborted——MPA 整页刷新后随发送请求建立的
       *  SSE 流已死，abort 终态只能经此通道到达；缺失时 streaming 占位消息永久卡在生成中 */
      'message.aborted': (data) => {
        const { messageId, otterId: dataOtterId, otterName: dataOtterName } = data as { messageId: string; otterId?: string; otterName?: string }
        const liveEvents = liveEventsMap.get(messageId) || []
        const meta = liveMeta.get(messageId)
        /** 身份以 SSE 事件为准（服务端已携带），liveMeta 作回退——与发送流处理器一致 */
        const otterId = dataOtterId || meta?.otterId || ''
        const otterName = dataOtterName ?? meta?.otterName
        /** 确保 otter 在 allOtters 中（chain 创建的新 otter 可能还没加入） */
        if (otterId && otterName && activeId) {
          setAllOtters(prev => {
            const convOtters = prev[activeId] || []
            if (convOtters.some(o => o.id === otterId)) return prev
            return { ...prev, [activeId]: [...convOtters, { id: otterId, name: otterName, type: 'small', createdAt: '' }] }
          })
        }
        /** upsertTerminalMessage 与已有投影合并保留 events/seq/ts 等字段（第四轮检视 S4-1） */
        const abortedMsg: LocalMessage = {
          id: messageId, st: 'otter', si: otterId, sn: otterName,
          content: (data.body as string) ?? '[中断]', status: 'aborted', ts: meta?.createdAt || '', dur: null,
          events: liveEvents.length > 0 ? liveEvents : undefined,
        }
        batchUpdateMessages(activeId!, (list) => upsertTerminalMessage(list, abortedMsg))
        if (!abortNotifiedRef.current.has(messageId)) {
          abortNotifiedRef.current.add(messageId)
          showToast('回复已中断', 'info')
        }
        liveEventsMap.delete(messageId)
        liveMeta.delete(messageId)
        liveText.delete(messageId)
      },
      'error': (data) => {
        const messageId = data.messageId as string | undefined
        const errMsg: LocalMessage = {
          id: messageId || `err-${crypto.randomUUID()}`, st: 'otter', si: (data.otterId as string) || 'unknown',
          content: `[错误] ${data.message}`, status: 'failed', ts: nowTs(), dur: null,
        }
        /** messageId 存在时走 upsertTerminalMessage 保留投影字段（F20260805abpp S4-1 同类） */
        batchUpdateMessages(activeId!, (list) => messageId ? upsertTerminalMessage(list, errMsg) : upsertMessage(list, errMsg))
        showToast(`Agent 错误: ${data.message}`, 'error')
      },
    }

    // SSE 订阅：用 XMLHttpRequest 流式读取，带指数退避重连
    let xhr: XMLHttpRequest | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectDelay = 1000
    const maxDelay = 30000
    let disposed = false

    function connect() {
      if (disposed) return
      xhr = new XMLHttpRequest()
      xhr.open('GET', `/api/conversations/${activeId}/subscribe`)
      let buffer = ''
      let currentEvent = ''
      let currentData = ''
      /** 已消费的 responseText 字节数。responseText 是累积全量，而 buffer 处理完行后会
       *  变短——若用 buffer.length 做偏移，每次 onprogress（含 15s keep-alive 心跳）都会
       *  从头重放整个流，追加型 handler（speak.intermediate 累积）每跳一次翻一倍（F20260819spyd）。
       *  cursor 只增不减，buffer 仅承载跨 chunk 的不完整尾行。 */
      let processedLen = 0

      xhr.onprogress = () => {
        if (!xhr) return
        if (xhr.responseText.length <= processedLen) return
        buffer += xhr.responseText.slice(processedLen)
        processedLen = xhr.responseText.length
        const lines = buffer.split('\n')
        buffer = lines.pop()!

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7)
          } else if (line.startsWith('data: ')) {
            currentData = line.slice(6)
          } else if (line === '' && currentEvent) {
            try {
              const data = JSON.parse(currentData)
              handlers[currentEvent]?.(data)
            } catch (err) { console.warn('[SSE-subscribe] malformed JSON:', currentEvent, currentData.slice(0, 80), err) }
            currentEvent = ''
            currentData = ''
          }
        }
        // 收到数据后重置重连延迟
        reconnectDelay = 1000
      }

      xhr.onerror = () => { scheduleReconnect() }
      xhr.onload = () => { if (!disposed) scheduleReconnect() }

      xhr.send()
    }

    function scheduleReconnect() {
      if (disposed) return
      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, maxDelay)
        connect()
      }, reconnectDelay)
    }

    connect()

    return () => {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (xhr) xhr.abort()
    }
  }, [activeId, batchUpdateMessages])

  useEffect(() => {
    for (const otter of Object.values(allOtters).flat()) {
      if (!sessions[otter.id]) {
        api.getSessionHistory(otter.id)
          .then(dtos => setSessions(prev => ({ ...prev, [otter.id]: dtos.map(mapSessionDTO) })))
          .catch(err => console.error(`Failed to load sessions for otter ${otter.id}:`, err))
      }
    }
  }, [allOtters, sessions])

  const activeConv = conversations.find(c => c.id === activeId) || null
  const activeMessages = useMemo(() => activeId ? (allMessages[activeId] || []) : [], [activeId, allMessages])
  const activeLinkedRes = useMemo(() => activeId ? (allLinkedRes[activeId] || []) : [], [activeId, allLinkedRes])
  const activeOtters: LocalOtter[] = useMemo(() => activeId ? (allOtters[activeId] || []) : [], [activeId, allOtters])

  const handleSend = useCallback(async (text: string, mentionOtterId?: string) => {
    if (!activeId) return
    /** 有 @ 则指定目标；无 @ 传空数组，由后端按规则解析（回复最后发言者，兜底大獭） */
    const targetOtterIds = mentionOtterId ? [mentionOtterId] : []

    const userMsg: LocalMessage = {
      id: 'tmp-' + Date.now(), st: 'user', si: 'user',
      content: text, ts: nowTs(), dur: null,
    }
    setAllMessages(prev => ({
      ...prev,
      [activeId]: [...(prev[activeId] || []), userMsg],
    }))
    /** 发送失败时移除乐观 tmp 消息（避免幻影消息被轮询 merge 永久保留） */
    const removeTmpMsg = () => setAllMessages(prev => ({
      ...prev,
      [activeId]: (prev[activeId] || []).filter(m => m.id !== userMsg.id),
    }))

    try {
      const response = await api.sendMessage(activeId, {
        senderId: 'user', talkingStonePassedTo: targetOtterIds, body: text,
      })
      if (!response.ok) { removeTmpMsg(); showToast('发送失败', 'error'); return }

      /** 按 messageId 隔离的 liveEvents 与 otter 元信息（每个 otter 独立，仅本次发送流程内使用） */
      const liveEventsMap = new Map<string, Array<{ ts: string; eventType: string; payload: Record<string, unknown> }>>()
      const liveMeta = new Map<string, { otterId: string; otterName?: string; createdAt: string }>()
      /** F20260814qswp 三轮：累积+全量 set 幂等语义（见常驻通道 liveText 声明处注释） */
      const liveText = new Map<string, string>()

      /** SSE 事件就地更新 allMessages 中的进行中消息（统一渲染通道：消息流只有 allMessages 一条；
       *  F20260814qswp：改走 batchUpdateMessages，与批量暂存副本单轨，避免双轨覆盖） */
      const syncLiveEvents = (messageId: string) => {
        const liveEvents = liveEventsMap.get(messageId)
        if (!liveEvents) return
        batchUpdateMessages(activeId!, (list) => {
          if (!list.some(m => m.id === messageId)) return list
          return list.map(m => m.id === messageId ? { ...m, events: [...liveEvents] } : m)
        })
      }

      consumeSSE(response, {        'message.start': (data) => {
          const { messageId, otterId, otterName } = data
          liveEventsMap.set(messageId, [])
          liveMeta.set(messageId, { otterId, otterName, createdAt: data.createdAt || nowTs() })
          /** 进行中消息按服务端 sequence 插入消息流（M5：跨 otter 并发时序正确；同 id 原位替换兼容轮询快照） */
          const placeholder: LocalMessage = {
            id: messageId, st: 'otter', si: otterId, sn: otterName,
            content: '', status: 'streaming', seq: data.seq, ts: data.createdAt || nowTs(), dur: null, events: [],
          }
          batchUpdateMessages(activeId!, (list) => insertBySeq(list, placeholder))
          /** 确保发言者在参与者列表中（流中途 create_otter 的新獭）；fill-only，不覆盖已有条目 */
          if (otterId && activeId) {
            setAllOtters(prev => {
              const convOtters = prev[activeId] || []
              if (convOtters.some(o => o.id === otterId)) return prev
              return { ...prev, [activeId]: [...convOtters, { id: otterId, name: otterName, type: 'small', createdAt: '' }] }
            })
          }
          // message.start 计数由 GET 订阅统一处理，POST 流不重复计数
        },
        'assistant_toolcall': (data) => {
          const { messageId } = data
          const liveEvents = liveEventsMap.get(messageId)
          if (!liveEvents) return
          liveEvents.push({ ts: nowTs(), eventType: 'assistant_toolcall', payload: { content: data.content } })
          syncLiveEvents(messageId)
        },
        'tool.result': (data) => {
          const { messageId } = data
          const liveEvents = liveEventsMap.get(messageId)
          if (!liveEvents) return
          liveEvents.push({ ts: nowTs(), eventType: 'tool_result', payload: { name: data.toolName, result: data.result } })
          syncLiveEvents(messageId)
          refreshParticipantsAfterDissolve(data.toolName as string)
        },
        'assistant_text': (data) => {
          const { messageId } = data
          const liveEvents = liveEventsMap.get(messageId)
          if (!liveEvents) return
          liveEvents.push({ ts: nowTs(), eventType: 'assistant_text', payload: { content: data.content } })
          syncLiveEvents(messageId)
          /** F20260819spyd：assistant 文本不进气泡（同常驻通道注释——避免与 speak.intermediate 重复） */
        },
        'speak.intermediate': (data) => {
          const { messageId, body, otterName } = data as { messageId: string; body: string; otterName?: string }
          if (!body) return
          const acc = (liveText.get(messageId) || '') + (liveText.has(messageId) ? '\n\n' : '') + body
          liveText.set(messageId, acc)
          batchUpdateMessages(activeId!, (list) => {
            if (!list.some(m => m.id === messageId)) return list
            return list.map(m => m.id === messageId ? { ...m, content: acc, sn: m.sn || otterName || m.sn } : m)
          })
        },
        'message.complete': (data) => {
          const { messageId } = data
          const liveEvents = liveEventsMap.get(messageId) || []
          const meta = liveMeta.get(messageId)
          const otterId = meta?.otterId || data.otterId || ''
          /** body 来自 SSE 事件（后端 speak 完成后从 DB 取出），与 assistant_text 事件无关 */
          const finalMsg: LocalMessage = {
            id: messageId, st: 'otter', si: otterId, sn: meta?.otterName || data.otterName,
            content: data.body ?? '', status: 'completed', ts: meta?.createdAt || '', dur: data.duration,
            events: liveEvents.length > 0 ? liveEvents : undefined,
            ctx: data.ctx, ctxMax: data.ctxMax,
            turnId: data.turnId || undefined,
          }
          /** upsertTerminalMessage 原位替换 message.start 插入的占位消息并保留投影字段；
           *  M6：恰好一条未戳 tmp 时补戳 turnId（分隔线立即正确）；
           *  多条并发 tmp 时不戳（到达顺序未必等于发送顺序），留给轮询快照纠正 */
          batchUpdateMessages(activeId!, (list) => {
            const updated = upsertTerminalMessage(list, finalMsg)
            if (!data.turnId) return updated
            const unstamped = updated.filter(m => m.id.startsWith('tmp-') && !m.turnId)
            if (unstamped.length !== 1) return updated
            const tmpId = unstamped[0].id
            return updated.map(m => m.id === tmpId ? { ...m, turnId: data.turnId } : m)
          })
          liveEventsMap.delete(messageId)
          liveMeta.delete(messageId)
          liveText.delete(messageId)
        },
        'error': (data) => {
          const { messageId, otterId } = data
          const meta = messageId ? liveMeta.get(messageId) : undefined
          const errMsg: LocalMessage = {
            id: messageId || `err-${crypto.randomUUID()}`, st: 'otter', si: otterId || 'unknown',
            content: `[错误] ${data.message}`, status: 'failed', ts: meta?.createdAt || nowTs(), dur: null,
          }
          /** messageId 存在时走 upsertTerminalMessage 保留投影字段（F20260805abpp S4-1 同类） */
          batchUpdateMessages(activeId!, (list) => messageId ? upsertTerminalMessage(list, errMsg) : upsertMessage(list, errMsg))
          showToast(`Agent 错误: ${data.message}`, 'error')
          if (messageId) {
            liveEventsMap.delete(messageId)
            liveMeta.delete(messageId)
            liveText.delete(messageId)
          }
        },
        'message.aborted': (data) => {
          /** abort 后保留已有事件到 allMessages（与 message.failed 一致） */
          const { messageId } = data
          const liveEvents = liveEventsMap.get(messageId) || []
          const meta = liveMeta.get(messageId)
          /** 身份以 SSE 事件为准（服务端已携带），liveMeta 作回退 */
          const otterId = data.otterId || meta?.otterId || ''
          const otterName = data.otterName ?? meta?.otterName
          /** 确保 otter 在 allOtters 中（chain 创建的新 otter 可能还没加入） */
          if (otterId && otterName && activeId) {
            setAllOtters(prev => {
              const convOtters = prev[activeId] || []
              if (convOtters.some(o => o.id === otterId)) return prev
              return { ...prev, [activeId]: [...convOtters, { id: otterId, name: otterName, type: 'small', createdAt: '' }] }
            })
          }
          const abortedMsg: LocalMessage = {
            id: messageId, st: 'otter', si: otterId, sn: otterName,
            content: data.body ?? '[中断]', status: 'aborted', ts: meta?.createdAt || '', dur: null,
            events: liveEvents.length > 0 ? liveEvents : undefined,
          }
          /** upsertTerminalMessage 与已有投影合并保留 events/seq/ts 等字段（第四轮检视 S4-1） */
          batchUpdateMessages(activeId!, (list) => upsertTerminalMessage(list, abortedMsg))
          if (!abortNotifiedRef.current.has(messageId)) {
            abortNotifiedRef.current.add(messageId)
            showToast('回复已中断', 'info')
          }
          liveEventsMap.delete(messageId)
          liveMeta.delete(messageId)
          liveText.delete(messageId)
        },
        'message.failed': (data) => {
          /** 失败消息：body 来自 SSE 事件（服务端 sendMessage.fail 存储的失败原因） */
          const { messageId } = data
          const liveEvents = liveEventsMap.get(messageId) || []
          const meta = liveMeta.get(messageId)
          const otterId = meta?.otterId || data.otterId || ''
          const failedMsg: LocalMessage = {
            id: messageId, st: 'otter', si: otterId, sn: meta?.otterName || data.otterName,
            content: data.body ?? '[未完成]', status: 'failed', ts: meta?.createdAt || '', dur: null,
            events: liveEvents.length > 0 ? liveEvents : undefined,
          }
          batchUpdateMessages(activeId!, (list) => upsertTerminalMessage(list, failedMsg))
          liveEventsMap.delete(messageId)
          liveMeta.delete(messageId)
          liveText.delete(messageId)
        },
        'system.message': (data) => {
          const sysMsg: LocalMessage = {
            id: data.messageId, st: 'system', si: 'system',
            content: data.content, seq: data.seq as number, ts: nowTs(), dur: null,
          }
          batchUpdateMessages(activeId!, (list) => insertBySeq(list, sysMsg))
        },
        'agent.idle': () => { /* 信息性事件，不做处理 */ },
      }, { onError: () => {
        showToast('SSE 连接中断', 'error')
        /** SSE 中断不代表发言停止（刷新≠停止）：拉取快照播种进行中消息，让轮询续看接管 */
        if (activeId) refreshMessages(activeId)
      }, onDone: () => {
        /** 流结束后刷新参与者列表（agent 可能创建/解散了小獭） */
        if (activeId) {
          api.getParticipants(activeId).then(participants => {
            setAllOtters(prev => ({
              ...prev,
              [activeId]: participants.map(p => mapParticipantDTO(p)),
            }))
          }).catch(() => {})
        }
      } })
    } catch (err) {
      console.error('Failed to send message:', err)
      removeTmpMsg()
      showToast('发送失败', 'error')
    }
  }, [activeId, refreshMessages, batchUpdateMessages])

  /** 卡片提交 → 强制预览 → 回执复用 handleSend 整条 SSE 管线（显式路由卡片作者） */
  const { cardPreview, confirmCardPreview, rejectCardPreview } = useCardBridge({
    activeId,
    messages: activeMessages,
    onSendReply: (body, authorId) => { handleSend(body, authorId) },
  })

  const stopStream = useCallback((messageId: string) => {
    if (!activeId) return
    /** 乐观更新为已中断（即时反馈）；随后以服务端为该消息的权威状态收敛 */
    setAllMessages(prev => {
      const list = prev[activeId]
      if (!list?.some(m => m.id === messageId)) return prev
      return {
        ...prev,
        [activeId]: list.map(m => m.id === messageId && isInFlight(m)
          ? { ...m, status: 'aborted' as const, content: m.content || '[中断]' }
          : m),
      }
    })
    /** 收敛失败时回退为进行中，让轮询接管（abort 生效/丢失/已终态/拉取失败四条路径均可收敛） */
    const revertToInFlight = () => setAllMessages(prev => {
      const list = prev[activeId]
      if (!list?.some(m => m.id === messageId)) return prev
      return { ...prev, [activeId]: list.map(m => m.id === messageId ? { ...m, status: 'streaming' as const } : m) }
    })
    api.abortMessage(messageId)
      .catch((err) => console.error('Failed to abort message:', err))
      .finally(async () => {
        try {
          const serverMsg = mapMessageDTO(await api.getMessage(messageId))
          setAllMessages(prev => {
            const list = prev[activeId]
            if (!list?.some(m => m.id === messageId)) return prev
            /** getMessage 不含 events，保留本地已有事件 */
            return { ...prev, [activeId]: list.map(m => m.id === messageId ? { ...serverMsg, events: m.events } : m) }
          })
        } catch {
          revertToInFlight()
        }
      })
  }, [activeId])

  /** 标记已读防抖（避免滚动时频繁调用 API） */
  const markReadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (markReadDebounceRef.current) clearTimeout(markReadDebounceRef.current)
  }, [])

  /** 用户滚动到底部时标记已读（防抖 500ms） */
  const handleMarkRead = useCallback(() => {
    if (!activeId) return
    if (markReadDebounceRef.current) clearTimeout(markReadDebounceRef.current)
    markReadDebounceRef.current = setTimeout(() => {
      const msgs = allMessagesRef.current[activeId] || []
      const realMsgs = msgs.filter(m => !m.id.startsWith('tmp-') && !m.id.startsWith('err-') && m.seq != null)
      if (realMsgs.length === 0) return
      const maxSeq = Math.max(...realMsgs.map(m => m.seq!))
      api.markRead(activeId, maxSeq).catch(() => {})
      markReadDebounceRef.current = null
    }, 500)
  }, [activeId])

  /** 手动重试：对 failed/aborted 的 otter 消息重新触发 agent */
  const handleRetryMessage = useCallback(async (messageId: string) => {
    if (!activeId) return
    try {
      const response = await api.retryMessage(messageId)
      if (!response.ok) { showToast('重试失败', 'error'); return }

      const liveEventsMap = new Map<string, Array<{ ts: string; eventType: string; payload: Record<string, unknown> }>>()
      const liveMeta = new Map<string, { otterId: string; otterName?: string; createdAt: string }>()
      /** F20260814qswp 三轮：累积+全量 set 幂等语义（见常驻通道 liveText 声明处注释） */
      const liveText = new Map<string, string>()

      const syncLiveEvents = (msgId: string) => {
        const liveEvents = liveEventsMap.get(msgId)
        if (!liveEvents) return
        batchUpdateMessages(activeId, (list) => {
          if (!list.some(m => m.id === msgId)) return list
          return list.map(m => m.id === msgId ? { ...m, events: [...liveEvents] } : m)
        })
      }

      consumeSSE(response, {
        'message.start': (data) => {
          const { messageId: newMsgId, otterId, otterName } = data
          liveEventsMap.set(newMsgId, [])
          liveMeta.set(newMsgId, { otterId, otterName, createdAt: data.createdAt || nowTs() })
          const placeholder: LocalMessage = {
            id: newMsgId, st: 'otter', si: otterId, sn: otterName,
            content: '', status: 'streaming', seq: data.seq, ts: data.createdAt || nowTs(), dur: null, events: [],
          }
          batchUpdateMessages(activeId, (list) => insertBySeq(list, placeholder))
        },
        'assistant_toolcall': (data) => {
          const { messageId: msgId } = data
          const liveEvents = liveEventsMap.get(msgId)
          if (!liveEvents) return
          liveEvents.push({ ts: nowTs(), eventType: 'assistant_toolcall', payload: { content: data.content } })
          syncLiveEvents(msgId)
        },
        'tool.result': (data) => {
          const { messageId: msgId } = data
          const liveEvents = liveEventsMap.get(msgId)
          if (!liveEvents) return
          liveEvents.push({ ts: nowTs(), eventType: 'tool_result', payload: { name: data.toolName, result: data.result } })
          syncLiveEvents(msgId)
          refreshParticipantsAfterDissolve(data.toolName as string)
        },
        'assistant_text': (data) => {
          const { messageId: msgId, content } = data
          const liveEvents = liveEventsMap.get(msgId)
          if (!liveEvents) return
          /** F20260814qswp：事件形状对齐常驻/发送流（eventType:'assistant_text' + payload.content）。
           *  旧实现用 eventType:'text'/payload:{text}，MessageList 的 EventItem 只识别 'assistant_text'，
           *  重试消息的流式文本事件全部静默丢失（落入 return null） */
          liveEvents.push({ ts: nowTs(), eventType: 'assistant_text', payload: { content } })
          syncLiveEvents(msgId)
          /** F20260819spyd：assistant 文本不进气泡（同常驻通道注释——避免与 speak.intermediate 重复） */
        },
        'speak.intermediate': (data) => {
          const { messageId, body, otterName } = data as { messageId: string; body: string; otterName?: string }
          if (!body) return
          const acc = (liveText.get(messageId) || '') + (liveText.has(messageId) ? '\n\n' : '') + body
          liveText.set(messageId, acc)
          batchUpdateMessages(activeId!, (list) => {
            if (!list.some(m => m.id === messageId)) return list
            return list.map(m => m.id === messageId ? { ...m, content: acc, sn: m.sn || otterName || m.sn } : m)
          })
        },
        'message.complete': (data) => {
          const { messageId: msgId } = data
          const liveEvents = liveEventsMap.get(msgId) || []
          const meta = liveMeta.get(msgId)
          const otterId = meta?.otterId || data.otterId || ''
          const finalMsg: LocalMessage = {
            id: msgId, st: 'otter', si: otterId, sn: meta?.otterName || data.otterName,
            content: data.body ?? '', status: 'completed', ts: meta?.createdAt || '', dur: data.duration,
            events: liveEvents.length > 0 ? liveEvents : undefined,
            ctx: data.ctx, ctxMax: data.ctxMax,
            turnId: data.turnId || undefined,
          }
          batchUpdateMessages(activeId, (list) => upsertTerminalMessage(list, finalMsg))
        },
        'message.failed': (data) => {
          const { messageId: msgId } = data
          batchUpdateMessages(activeId, (list) =>
            list.map(m => m.id === msgId ? { ...m, status: 'failed' as const, content: data.body || m.content || '[未完成]' } : m))
        },
        'message.aborted': (data) => {
          const { messageId: msgId } = data
          batchUpdateMessages(activeId, (list) =>
            list.map(m => m.id === msgId ? { ...m, status: 'aborted' as const, content: data.body || m.content || '[中断]' } : m))
        },
        'error': (data) => {
          showToast(data.message || '重试出错', 'error')
        },
      })
    } catch {
      showToast('重试请求失败', 'error')
    }
  }, [activeId, batchUpdateMessages])

  const handleSelectConv = useCallback((id: string) => {
    // 混合架构：切换对话时整页刷新
    window.location.href = `/conversation/${id}`
  }, [])
  const handleNewConv = () => setModal({ type: 'new-conv' })
  const handleArchive = () => activeId && setModal({ type: 'archive', cid: activeId })

  const handleContextMenu = (e: React.MouseEvent, cid: string) => {
    e.preventDefault()
    const x = Math.min(e.clientX, window.innerWidth - 168)
    const y = Math.min(e.clientY, window.innerHeight - 90)
    setCtxMenu({ x, y, cid })
  }
  function closeCtxMenu() { setCtxMenu(null) }

  async function confirmNewConv(title: string) {
    try {
      const dto = await api.createConversation({ title })
      const conv = mapConversationDTO(dto)
      setConversations(prev => [conv, ...prev])
      setModal({ type: 'none' })
      showToast('对话已创建', 'success')
      // 混合架构：创建新对话后整页刷新，确保 URL 与内容一致
      window.location.href = `/conversation/${conv.id}`
    } catch { showToast('创建对话失败', 'error') }
  }

  async function confirmChild(title: string) {
    if (modal.type !== 'child') return
    try {
      const dto = await api.createConversation({ title })
      const conv = mapConversationDTO(dto)
      setConversations(prev => [...prev, conv])
      setModal({ type: 'none' })
      showToast('子对话已创建', 'success')
      // 混合架构：创建子对话后整页刷新，确保 URL 与内容一致
      window.location.href = `/conversation/${conv.id}`
    } catch { showToast('创建子对话失败', 'error') }
  }

  async function confirmArchive() {
    if (!activeId) return
    try {
      await api.archiveConversation(activeId)
      setModal({ type: 'none' })
      // 归档后当前对话从列表消失（服务端列表排除 archived），
      // 轮询合并会将其移除导致 activeConv 为 null、RightPanel 串到其他对话——与 pin/unpin 一致整页跳转
      // toast 通过 URL 参数传递到目标页，避免跳转后来不及渲染
      window.location.href = '/conversation?archived=1'
    } catch { showToast('操作失败', 'error') }
  }

  async function confirmCreateOtter(name: string, role: string, resp: string[]) {
    if (!activeId) return
    try {
      const convOtters = allOtters[activeId] || []
      const dto = await api.createOtter({
        name, type: 'small',
        role: { name: role, responsibilities: resp },
        parentOtterId: convOtters[0]?.id,
        systemPrompt: `你是${name}，角色：${role}。职责：${resp.join('、')}`,
      })
      const otter = mapOtterDTO(dto)
      setAllOtters(prev => ({ ...prev, [activeId]: [...(prev[activeId] || []), otter] }))
      setModal({ type: 'none' }); showToast(`小獭 ${name} 已创建`, 'success')
    } catch { showToast('创建小獭失败', 'error') }
  }

  async function confirmDissolve(summary: string) {
    if (modal.type !== 'dissolve') return
    try {
      await api.dissolveOtter(modal.otterId, summary)
      setAllOtters(prev => {
        const updated: Record<string, LocalOtter[]> = {}
        for (const [cid, otters] of Object.entries(prev)) {
          updated[cid] = otters.filter(o => o.id !== modal.otterId)
        }
        return updated
      })
      setConversations(prev => prev.map(c => ({ ...c, otterIds: c.otterIds.filter(id => id !== modal.otterId) })))
      setModal({ type: 'none' }); showToast('小獭已解散', 'success')
    } catch { showToast('解散失败', 'error') }
  }

  async function confirmRestart(summary: string) {
    if (modal.type !== 'restart') return
    const otterId = modal.otterId
    try {
      await api.restartOtter(otterId, summary)
      /** F20260805rsto：重启后重拉 session 链——加载 effect 有 `!sessions[id]` 守卫，
       *  不主动重拉的话弹窗/卡片一直显示旧数据直到刷新页面 */
      const dtos = await api.getSessionHistory(otterId)
      setSessions(prev => ({ ...prev, [otterId]: dtos.map(mapSessionDTO) }))
      setModal({ type: 'none' }); showToast('前世已封存，新一世獭生已开始', 'success')
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
      showToast('关键资源已添加', 'success')
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

  async function ctxAction(action: string, cid: string) {
    closeCtxMenu()
    // 混合架构：右键菜单操作时整页刷新，确保 URL 与内容一致
    if (action === 'archive') {
      setModal({ type: 'archive', cid })
    } else if (action === 'child') {
      setModal({ type: 'child', parentId: cid })
    } else if (action === 'pin') {
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
    } else {
      window.location.href = `/conversation/${cid}`
    }
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
        <LeftPanel conversations={conversations} activeId={activeId || ''} onSelect={handleSelectConv} onNewConversation={handleNewConv} onContextMenu={handleContextMenu} otters={Object.values(allOtters).flat()} />
        <ChatView conversation={activeConv} messages={activeMessages} state={pageState} onSend={handleSend} onStopStream={stopStream} onRetryMessage={handleRetryMessage} onRetry={() => { setPageState('normal'); showToast('正在重试...', 'info') }} onGoToSettings={() => { window.location.href = '/settings' }} onArchive={handleArchive} otters={activeOtters} conversationId={activeId || ''} isAtBottomRef={isAtBottomRef} newMessagesCount={newMessagesCount} onJumpToBottom={handleJumpToBottom} onLoadMore={loadMoreBefore} loadingMore={loadingMore} unreadSeparatorSeq={unreadSeparatorSeq} highlightMessageId={highlightMessageId} cardPreview={cardPreview} onConfirmCard={confirmCardPreview} onRejectCard={rejectCardPreview} userName={userName} onReachBottom={handleMarkRead} />
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
          <div className="fixed glass-overlay rounded-2xl p-1 z-50 min-w-[150px]" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <div onClick={() => ctxAction(activeConvForMenu.pinned ? 'unpin' : 'pin', ctxMenu.cid)} className="px-2.5 py-1.5 rounded-lg text-xs cursor-pointer hover:bg-white/40 text-stone-600">{activeConvForMenu.pinned ? '取消置顶' : '置顶'}</div>
            <div onClick={() => ctxAction('archive', ctxMenu.cid)} className={`px-2.5 py-1.5 rounded-lg text-xs cursor-pointer ${activeConvForMenu.status !== 'archived' ? 'hover:bg-white/40 text-stone-600' : 'text-stone-300 cursor-not-allowed'}`}>归档对话</div>
            <div onClick={() => ctxAction('child', ctxMenu.cid)} className="px-2.5 py-1.5 rounded-lg text-xs cursor-pointer hover:bg-white/40 text-stone-600">创建子对话</div>
          </div>
        </>
      )}

      <ConversationModals modal={modal} otters={activeOtters} sessions={sessions} onClose={() => setModal({ type: 'none' })} onConfirmNewConv={confirmNewConv} onConfirmChild={confirmChild} onConfirmArchive={confirmArchive} onConfirmCreateOtter={confirmCreateOtter} onConfirmDissolve={confirmDissolve} onConfirmRestart={confirmRestart} onConfirmLinkResource={confirmLinkResource} onOpenRestart={(oid) => setModal({ type: 'restart', otterId: oid })} onOpenDissolve={(oid) => setModal({ type: 'dissolve', otterId: oid })} />

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
          onJumpToMessage={handleJumpToMessage}
        />
      )}
    </AppLayout>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<ConversationPage />)
