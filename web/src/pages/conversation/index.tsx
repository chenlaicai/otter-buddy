import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { PanelLeft, PanelRight } from 'lucide-react'
import '../../styles/globals.css'

import type { LocalOtter, LocalConversation, LocalMessage, LocalLinkedResource, LocalOtterSession, LocalScheduledTask } from '../../lib/mappers'

import { mapOtterDTO, mapConversationDTO, mapEntryDTO, mapLinkedResourceDTO, mapSessionDTO, mapParticipantDTO } from '../../lib/mappers'
import { isInFlight, upsertMessage, insertBySeq, upsertTerminalMessage, insertCenteredByTs } from '../../lib/message-stream'
import { applyInvokeStart, applyInvokeEnd, findOtterByInvokeId, type InvokeStates } from '../../lib/invoke-tracker'
import { MessageBatcher } from '../../lib/batch-update'
import { nowTs } from '../../lib/utils'
import { AppLayout } from '../../components/AppLayout'
import { showToast } from '../../components/Toast'
import { LeftPanel } from './LeftPanel'
import { ChatView } from './ChatView'
import { RightPanel } from './RightPanel'
import { ConversationModals, type ModalState, type CreateOtterFormValue } from './Modals'
import { setOtterAvatarOverride } from '../../lib/otter-avatars'
import { mergeOttersIfChanged } from '../../lib/shallow-equal-otters'
import { useMediaQuery } from '../../hooks/use-media-query'
import { useConversationListPolling } from '../../hooks/use-conversation-list-polling'
import { useDeferredOps } from './hooks/useDeferredOps'
import { ScheduledTaskModal } from './ScheduledTaskModal'
import { ExecutionHistoryModal } from './ExecutionHistoryModal'
import { SessionModal } from './SessionModal'
import { useScheduledTasks } from './hooks/useScheduledTasks'
import { useCardBridge } from './hooks/useCardBridge'
import * as api from '../../api/client'
import { ApiError } from '../../api/client'
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
  /** F20260910ctlv：獭 invoke 实时状态（右侧栏面板数据源；invoke.start/end 事件驱动） */
  const [invokeStates, setInvokeStates] = useState<InvokeStates>({})
  const [allOtters, setAllOtters] = useState<Record<string, LocalOtter[]>>({})
  const [sessions, setSessions] = useState<Record<string, LocalOtterSession[]>>({})
  const [allLinkedRes, setAllLinkedRes] = useState<Record<string, LocalLinkedResource[]>>({})
  const [modal, setModal] = useState<ModalState>({ type: 'none' })
  const [pageState, setPageState] = useState<'normal' | 'empty' | 'loading' | 'error' | 'no-llm'>('loading')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; cid: string } | null>(null)

  /** #500：响应式断点——lg(1024px) 以上三栏全开；md(768px) 以上左栏常驻。
   *  窄屏时面板抽屉化（悬浮不挤压聊天区），按钮切换展开。 */
  const isLgUp = useMediaQuery('(min-width: 1024px)')
  const isMdUp = useMediaQuery('(min-width: 768px)')
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false)
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false)
  /** 跨回宽屏断点时复位抽屉状态（避免 resize 后按钮 aria-expanded 与实际不符） */
  useEffect(() => {
    if (isLgUp && isMdUp) { setLeftDrawerOpen(false); setRightDrawerOpen(false) }
  }, [isLgUp, isMdUp])

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
  /** F20260910ctlv：invokeStates / otters 镜像 ref——SSE handler 闭包读最新值
   *  （handler 在 activeId effect 内创建，若直接读 state 会闭包性过期） */
  const invokeStatesRef = useRef<InvokeStates>({})
  useEffect(() => { invokeStatesRef.current = invokeStates }, [invokeStates])
  const ottersRef = useRef<Record<string, LocalOtter[]>>({})
  useEffect(() => { ottersRef.current = allOtters }, [allOtters])
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
  /** F20260825scrf：弹窗打开期间冻结 SSE 批量应用——backdrop-filter 重算由 scrim
   *  背后像素变化驱动（非 React re-render，上轮 memo 修复无效的根因），流式期间
   *  50ms 一批的文本追加使模糊采样持续失效。暂存链完整保留，关窗后 flush() 一次性
   *  追上（流式内容零丢失、视觉无损） */
  const modalOpenRef = useRef(false)
  const [modalOpen, setModalOpen] = useState(false)
  const batcher = useMemo(() => new MessageBatcher({
    windowMs: BATCH_WINDOW_MS,
    getBase: (convId) => allMessagesRef.current[convId] ?? [],
    getShouldDefer: () => modalOpenRef.current,
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
  /** F20260825scrf：关窗时 flush 冻结期间攒下的流式更新（下次打开前背景已追上
   *  真实状态；手动 flush 后 timer 自然空转，无害）。ref 同步在 render 阶段
   *  （isAnyModalOpen 处）——effect 同步存在 commit→effect 间隙，弹窗打开瞬间
   *  batcher timer 到期会穿透 defer（检视 S-2） */
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
  /** F20260910ctlv：Session 弹窗（点击獭头像弹出，展示该獭 invoke 历史与流式过程） */
  const [sessionModalOtter, setSessionModalOtter] = useState<LocalOtter | null>(null)
  /** F20260825scrf：modalOpen 派生（8 种 ConversationModals + 定时任务/执行历史 modal）。
   *  下沉到 index 顶层供 batcher/轮询冻结用；setModalOpen 仅在此处同步 */
  const isAnyModalOpen = modal.type !== 'none' || scheduledTaskModal.type !== 'none' || executionHistoryTaskId !== null
  /** F20260827scrf2（第五源治理）：SSE 回调里的 setAllOtters 直接 setState 绕过全部冻结
   *  gate（batcher defer / 轮询 gate / refreshMessages 守卫）——多獭流式场景每 turn 的
   *  message.start/complete/aborted/onDone 都驱动右栏+消息区 re-render，scrim 背景
   *  像素变化 → 闪烁（8/25 验证环境未复现因当时对话内无小獭增量，fill-only 提前 return）。
   *  治理：统一入口 upsertOtterIfAbsentDeferred——弹窗期攒进 pendingOtters，关窗 flush。
   *  fill-only 幂等语义保证延迟更新安全；全量替换（onDone 参与者刷新）跳过后关窗由
   *  upsert 链补齐参与者，无永久丢失 */
  const { runOrDefer, flush: flushDeferredOps } = useDeferredOps(() => modalOpenRef.current)
  const upsertOtterIfAbsentDeferred = useCallback((otterId: string, otterName?: string, convId?: string) => {
    const apply = (prev: Record<string, LocalOtter[]>) => {
      const cid = convId || activeId
      if (!cid || !otterId) return prev
      const convOtters = prev[cid] || []
      if (convOtters.some(o => o.id === otterId)) return prev
      const newOtter: LocalOtter = { id: otterId, name: otterName || '', type: 'small', createdAt: '' }
      return { ...prev, [cid]: [...convOtters, newOtter] }
    }
    runOrDefer(() => setAllOtters(apply))
  }, [activeId, runOrDefer])

  /** F20260827scrf2：关窗 flush——batcher（流式 batch）与 deferred ops（参与者/徽标）
   *  同窗口重放，背景一次性追上真实状态 */
  useEffect(() => {
    if (!modalOpen) { batcher.flush(); flushDeferredOps() }
  }, [modalOpen, batcher, flushDeferredOps])
  /** F20260825scrf 检视 S-2 修复：render 阶段同步 ref（镜像最新值模式）——useEffect
   *  同步存在 commit→effect 间隙，弹窗打开瞬间的 batcher timer 到期会读到旧值 false，
   *  flush 穿透 defer 产生单帧闪烁。render 赋值幂等，StrictMode 双 render 无害 */
  modalOpenRef.current = isAnyModalOpen
  useEffect(() => {
    setModalOpen(isAnyModalOpen)
  }, [isAnyModalOpen])


  // 定时任务 Hook
  const {
    tasks: scheduledTasks,
    loading: scheduledTasksLoading,
    toggleStatus: toggleScheduledTaskStatus,
    create: createScheduledTask,
    update: updateScheduledTask,
    remove: deleteScheduledTask,
    trigger: triggerScheduledTask,
  } = useScheduledTasks(activeId, !modalOpen)

  /** dissolve_otter 工具执行完成后刷新参与者列表（DRY 提取，检视獭 review F1） */
  const refreshParticipantsAfterDissolve = useCallback((toolName: string) => {
    if (toolName !== 'dissolve_otter' || !activeId) return
    api.getParticipants(activeId).then(participants => {
      // #502：内容未变时保引用，避免 RightPanel 整树 re-render 引发 hover 快览卡微闪
      // F20260827scrf2：弹窗期延迟到关窗 flush（runOrDefer），不驱动背景像素变化
      const apply = (prev: Record<string, LocalOtter[]>) =>
        mergeOttersIfChanged(prev, activeId, participants.map(p => mapParticipantDTO(p)))
      runOrDefer(() => setAllOtters(apply))
    }).catch(err => console.error('Failed to refresh participants after dissolve:', err))
  }, [activeId, runOrDefer])

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
    // NOTE: useEffect([], []) 只在 mount 时执行。当前 MPA 模式下 window.location.href
    // 整页跳转会重新 mount，行为正确。未来改 SPA 路由时需改为响应式（如 context/store）。
    api.getSettings()
      .then(s => setUserName(s.userName ?? ''))
      .catch(() => console.warn('[ConversationPage] Failed to load userName setting'))
    // urlConvId 源自 window.location.pathname，MPA 模式下 mount 后不变，行为等价
  }, [urlConvId])

  // 活动状态轮询：每 5 秒刷新对话列表（仅在页面可见时）。
  // F20260825scrf：弹窗打开期间暂停——mergeConversations 每次产出新引用（流式期间
  //  lastMessagePreview 持续变化），轮询会驱动 scrim 背后像素变化；关窗后 interval 立即重建
  useConversationListPolling(pageState !== 'loading' && pageState !== 'error' && !modalOpen, setConversations)

  const loadConversationDetail = useCallback(async (convId: string) => {
    try {
      // F20260910ctlv 彻底切换：时间线唯一数据源 = entries（messages 渲染路径退役）
      const [entriesResp, keyInfo, participants] = await Promise.all([
        api.listEntries(convId, 50),
        api.getKeyResources(convId),
        api.getParticipants(convId),
      ])
      // 未读状态独立加载，失败不阻塞会话展示（降级为无未读）
      const unread = await api.getUnreadState(convId).catch(() => ({
        lastReadSeq: 0, unreadCount: 0, firstUnreadMessageId: null, firstUnreadSeq: null,
      }))
      // entries 全量映射（ASC；单一 sequenceNum 排序天然单调——跨表排序问题消失）
      const msgs = entriesResp.entries.map(mapEntryDTO)
      setHasMoreBefore(entriesResp.hasMore)
      setUnreadState(unread)
      // 首次访问（无已读记录）：初始化已读到最新，避免下次进入显示全部未读
      if (unread.lastReadSeq === 0 && unread.unreadCount === 0 && msgs.length > 0) {
        const maxSeq = msgs[msgs.length - 1]?.seq
        if (maxSeq != null) api.markRead(convId, maxSeq).catch(() => {})
      }
      setUnreadSeparatorSeq(null)
      // 未读定位：第一条未读条目
      if (unread.firstUnreadSeq != null) {
        setUnreadSeparatorSeq(unread.firstUnreadSeq)
      }
      setAllMessages(prev => ({
        ...prev,
        [convId]: msgs,
      }))
      setAllLinkedRes(prev => ({
        ...prev,
        [convId]: keyInfo.resources.map(mapLinkedResourceDTO),
      }))
      // 更新 allOtters，按对话存储（#502：浅比较保引用，防轮询/重进对话时 hover 卡微闪）
      setAllOtters(prev => mergeOttersIfChanged(prev, convId, participants.map(p => mapParticipantDTO(p))))
    } catch (err) {
      console.error('Failed to load conversation detail:', err)
      showToast('加载对话详情失败', 'error')
    }
  }, [])

  /** 静默刷新消息列表（轮询用，失败不打扰用户，下轮重试） */
  /** F20260910ctlv 彻底切换：增量刷新（entries after 游标）——SSE 断连兜底。
   *  时间线实体全部终态（user/speak/居中条目 completed），无 in-flight 轮询需求；
   *  invoke 运行态由 invoke.start/end 事件驱动 + 刷新时经右栏 API 收敛。 */
  const refreshMessages = useCallback(async (convId: string) => {
    if (modalOpenRef.current) return
    try {
      const list = allMessagesRef.current[convId] || []
      const realEntries = list.filter(m => !m.id.startsWith('tmp-') && !m.id.startsWith('err-') && m.seq != null)
      const newest = realEntries[realEntries.length - 1]
      if (!newest?.id) return
      const resp = await api.listEntriesAfter(convId, newest.id, 100)
      if (resp.entries.length > 0) {
        const newer = resp.entries.map(mapEntryDTO)
        setAllMessages(prev => {
          const current = prev[convId] || []
          const existingIds = new Set(current.map(m => m.id))
          const fresh = newer.filter(e => !existingIds.has(e.id))
          if (fresh.length === 0) return prev
          return { ...prev, [convId]: [...current, ...fresh] }
        })
      }
    } catch (err) {
      console.error('Failed to refresh entries:', err)
    }
  }, [])

  /** 点击"新消息 N 条"浮窗：滚到底部 + 清零计数 */
  const handleJumpToBottom = useCallback(() => {
    // 找到滚动容器，滚到底部
    const scrollEl = document.querySelector('[data-message-list]') as HTMLElement
    if (scrollEl) {
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' })
    }
    setNewMessagesCount(0)
  }, [])

  /** F20260910ctlv 彻底切换：向上加载更旧历史（entries before 游标） */
  const loadMoreBefore = useCallback(async () => {
    if (!activeId || loadingMoreRef.current || !hasMoreBefore) return
    const list = allMessagesRef.current[activeId] || []
    const oldest = list[0]
    if (!oldest?.id) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const resp = await api.listEntries(activeId, 20, oldest.id)
      if (resp.entries.length === 0) { setHasMoreBefore(false); return }
      const olderMsgs = resp.entries.map(mapEntryDTO) // ASC
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
  }, [activeId, hasMoreBefore])

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

  /** 订阅消息广播（支持飞书消息实时同步到 Web，含 agent streaming 事件） */
  useEffect(() => {
    if (!activeId) return

    // F20260910ctlv：invoke 生命周期跟踪（invokeStates 独立 reducer，不进消息列表）
    const syncInvokeState = (updater: (prev: InvokeStates) => InvokeStates) => {
      setInvokeStates(prev => updater(prev))
    }

    // F20260910ctlv 彻底切换：事件分发器——单通道（entry.* / invoke.*；message.* 已退役）
    const handlers: Record<string, (data: Record<string, unknown>) => void> = {
      'entry.user': (data) => {
        const d = data as { entryId: string; sequenceNum?: number; senderId?: string; body?: string; createdAt?: string; yieldTargets?: string[] }
        const userMsg: LocalMessage = {
          id: d.entryId, st: 'user', si: d.senderId || 'user',
          content: d.body ?? '', status: 'completed', seq: d.sequenceNum, ts: d.createdAt || nowTs(), dur: null,
          // F20260910ctlv 收尾：yieldTargets = 发言石目标（user 气泡「→ 目标」传递行）
          yieldTargets: d.yieldTargets ?? null,
        }
        let added = false
        batchUpdateMessages(activeId!, (current) => {
          if (current.some(m => m.id === userMsg.id)) return current
          // F20260910ctlv 补漏：tmp 乐观气泡替换（同会话末尾同内容 user tmp → 真实 entryId）——
          // POST 流与常驻通道都会收到 entry.user，不替换则同一句话渲染两条
          const tmpIdx = [...current].reverse().findIndex(m =>
            m.id.startsWith('tmp-') && m.st === 'user' && m.content === userMsg.content)
          if (tmpIdx !== -1) {
            const idx = current.length - 1 - tmpIdx
            added = true
            const next = [...current]
            next[idx] = userMsg
            return next
          }
          added = true
          return [...current, userMsg]
        })
        if (added) { const atBottom = isAtBottomRef.current; runOrDefer(() => { if (!atBottom) setNewMessagesCount(c => c + 1) }) }
      },
      'entry.start': (data) => {
        /** speak entry 创建——插入獭气泡占位（content 由 entry.speak 填充） */
        const d = data as { entryId: string; invokeId?: string; otterId: string; otterName?: string; createdAt?: string }
        const placeholder: LocalMessage = {
          id: d.entryId, st: 'otter', si: d.otterId, sn: d.otterName,
          content: '', status: 'streaming', ts: d.createdAt || nowTs(), dur: null, events: [],
          invokeId: d.invokeId,
        }
        let added = false
        batchUpdateMessages(activeId!, (current) => {
          if (current.some(m => m.id === d.entryId)) return current
          added = true
          return [...current, placeholder]
        })
        if (d.otterId) {
          upsertOtterIfAbsentDeferred(d.otterId, d.otterName, activeId)
        }
        if (added) { const atBottom = isAtBottomRef.current; runOrDefer(() => { if (!atBottom) setNewMessagesCount(c => c + 1) }) }
      },
      'entry.speak': (data) => {
        /** speak entry body——speak entry 创建即全量 body（无流式分片） */
        const d = data as { entryId: string; body?: string; otterName?: string }
        if (!d.body) return
        batchUpdateMessages(activeId!, (list) => {
          if (!list.some(m => m.id === d.entryId)) return list
          return list.map(m => m.id === d.entryId ? { ...m, content: d.body ?? m.content, sn: m.sn || d.otterName || '' } : m)
        })
      },
      // F20260910ctlv 收尾：entry.complete 事件已退役（后端无发射点；speak 气泡终态由 invoke.end 收敛）
      'entry.failed': (data) => {
        const d = data as { entryId: string; invokeId?: string; body?: string; otterId?: string; otterName?: string }
        /** invoke 级失败（invokeId 锚）——刷新后由 invoke_end entry 呈现，实时阶段：
         *  无对应 speak 气泡时插一条 failed 消息（重试按钮数据源）；有则置 failed */
        const failedMsg: LocalMessage = {
          id: d.entryId, st: 'otter', si: d.otterId || '', sn: d.otterName,
          content: d.body ?? '[未完成]', status: 'failed', ts: nowTs(), dur: null,
          invokeId: d.invokeId,
        }
        batchUpdateMessages(activeId!, (list) => upsertTerminalMessage(list, failedMsg))
        showToast(d.body ? `执行失败: ${String(d.body).slice(0, 60)}` : '执行失败', 'error')
      },
      'entry.retry': (data) => {
        /** invoke 内自动重试——前端提示（invokeStates 仍 running；右栏「思考中」持续） */
        const d = data as { invokeId?: string; reason?: string; attempt?: number }
        showToast(`第 ${d.attempt ?? '?'} 次自动重试：${d.reason ?? ''}`, 'info')
      },
      'entry.aborted': (data) => {
        const d = data as { entryId: string; invokeId?: string; body?: string; otterId?: string; otterName?: string }
        const otterId = d.otterId || ''
        const otterName = d.otterName
        if (otterId && otterName && activeId) {
          upsertOtterIfAbsentDeferred(otterId, otterName, activeId)
        }
        /** invoke 级中止——失败气泡（可重试）；speak entry 若已存在则保留（发言有效） */
        const abortedMsg: LocalMessage = {
          id: d.entryId, st: 'otter', si: otterId, sn: otterName,
          content: d.body ?? '[中断]', status: 'aborted', ts: nowTs(), dur: null,
          invokeId: d.invokeId,
        }
        batchUpdateMessages(activeId!, (list) => upsertTerminalMessage(list, abortedMsg))
        if (!abortNotifiedRef.current.has(d.entryId)) {
          abortNotifiedRef.current.add(d.entryId)
          showToast('回复已中断', 'info')
        }
      },
      'error': (data) => {
        const d = data as { message?: string; invokeId?: string; otterId?: string }
        const errMsg: LocalMessage = {
          id: d.invokeId || `err-${crypto.randomUUID()}`, st: 'otter', si: (d.otterId as string) || 'unknown',
          content: `[错误] ${d.message}`, status: 'failed', ts: nowTs(), dur: null,
        }
        batchUpdateMessages(activeId!, (list) => upsertMessage(list, errMsg))
        showToast(`Agent 错误: ${d.message}`, 'error')
      },
      // ── invoke 生命周期（右栏状态面板数据源；同时驱动时间线居中条目与 speak 气泡终态）──
      'invoke.start': (data) => {
        const d = data as { invokeId: string; otterId: string; otterName?: string; triggerEntryId?: string; startedAt?: string }
        const startTs = d.startedAt || nowTs()
        syncInvokeState(prev => applyInvokeStart(prev, {
          invokeId: d.invokeId, otterId: d.otterId, otterName: d.otterName || '',
          conversationId: activeId, startedAt: startTs,
        }))
        /** F20260910ctlv 收尾：invoke_start 居中条目（DB 已落，前端实时插入——id 锚 triggerEntryId）。
         *  entry.body（如「🦦 大獭开始行动～」）不在事件载荷里，前端用约定文案回退，
         *  刷新后走 entries 历史接口拿到真实 body */
        const triggerEntryId = d.triggerEntryId
        if (triggerEntryId) {
          batchUpdateMessages(activeId!, (list) => insertCenteredByTs(list, {
            id: triggerEntryId, st: 'otter', si: d.otterId, sn: d.otterName,
            content: '', ts: startTs, dur: null,
            entryType: 'invoke_start', invokeId: d.invokeId, status: 'completed',
          }))
        }
        /** 獭可能在 chain 中新建，保证右栏参与者列表能见 */
        if (d.otterId) upsertOtterIfAbsentDeferred(d.otterId, d.otterName, activeId)
      },
      'invoke.end': (data) => {
        const d = data as { invokeId: string; otterId?: string; status: 'completed' | 'failed' | 'aborted'; endedAt?: string }
        const otterId = d.otterId || findOtterByInvokeId(invokeStatesRef.current, d.invokeId)
        if (!otterId) return
        const endedAt = d.endedAt || nowTs()
        syncInvokeState(prevStates => applyInvokeEnd(prevStates, {
          invokeId: d.invokeId, otterId, status: d.status, endedAt,
        }))
        /** F20260910ctlv 收尾（问题 3 根因）：invoke 结束 = 该 invoke 名下 speak 气泡终态收敛。
         *  后端无 entry.complete 发射点（speak entry 落库即 completed）——此前气泡 status
         *  停留 streaming，「停止生成」按钮永久残留。invokeId 驱动批量收敛（非 entryId 逐条）。 */
        batchUpdateMessages(activeId!, (list) => list.map(m =>
          m.invokeId === d.invokeId && isInFlight(m)
            ? { ...m, status: d.status === 'completed' ? 'completed' as const : d.status === 'aborted' ? 'aborted' as const : 'failed' as const, content: m.content || (d.status === 'completed' ? '' : d.status === 'aborted' ? '[中断]' : '[未完成]') }
            : m))
      },
      'entry.yield': (data) => {
        const d = data as { entryId: string; invokeId?: string; otterId?: string; otterName?: string; yieldTargets?: string[] }
        const targets = (d.yieldTargets || []).map((t: string) => ottersRef.current[activeId]?.find(o => o.id === t)?.name || t)
        batchUpdateMessages(activeId!, (list) => insertCenteredByTs(list, {
          id: d.entryId, st: 'otter', si: d.otterId || '', sn: d.otterName,
          content: '', ts: nowTs(), dur: null,
          entryType: 'yield', invokeId: d.invokeId, yieldTargets: targets,
        }))
      },
      'entry.system': (data) => {
        const d = data as { entryId: string; content: string; seq?: number }
        const sysMsg: LocalMessage = {
          id: d.entryId, st: 'system', si: 'system', content: d.content,
          status: 'completed', seq: d.seq, ts: nowTs(), dur: null, entryType: 'system',
        }
        batchUpdateMessages(activeId!, (list) => upsertMessage(list, sysMsg))
      },
      // ── 通用事件 ──
      'agent.idle': () => { /* 信息性事件，不做处理 */ },
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
  }, [activeId, batchUpdateMessages, upsertOtterIfAbsentDeferred])

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

  const handleSend = useCallback(async (text: string, mentionOtterIds?: string[], attachments?: import('./hooks/useAttachmentStaging').StagedAttachment[]) => {
    if (!activeId) return
    /** F20260904smsj：发言 = 已看完全部（聊天通用语义）——立即标记已读到当前最新 +
     *  强制回底部 + 清未读分隔线，消除「分隔线定位 × 自动滚底门控」竞争导致的视口上跳。
     *  此前：发言时若上一轮獭回复未读，轮询刷新会让视口跳向未读消息位置；
     *  且 isAtBottomRef=false 时插入新消息不触发滚底，最新消息不可见。 */
    isAtBottomRef.current = true
    setNewMessagesCount(0)
    setUnreadSeparatorSeq(null)
    {
      const msgs = allMessagesRef.current[activeId] || []
      const realMsgs = msgs.filter(m => !m.id.startsWith('tmp-') && !m.id.startsWith('err-') && m.seq != null)
      const maxSeq = realMsgs.length > 0 ? Math.max(...realMsgs.map(m => m.seq!)) : null
      if (maxSeq != null) api.markRead(activeId, maxSeq).catch(() => {})
    }
    /** 有 @ 则指定目标；无 @ 传空数组，由后端按规则解析（回复最后发言者，兜底大獭） */
    const targetOtterIds = mentionOtterIds ?? []
    /** 多模态 Phase 1：附件从 ChatView 中转区传入（上传已完成，此处只带服务端 id 引用） */
    const attachmentIds = attachments?.map(a => a.id)

    const userMsg: LocalMessage = {
      id: 'tmp-' + Date.now(), st: 'user', si: 'user',
      content: text, ts: nowTs(), dur: null,
      ...(attachments && attachments.length > 0 && { atts: attachments.map(({ localPreviewUrl: _u, uploading: _up, ...a }) => a) }),
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
        ...(attachmentIds && attachmentIds.length > 0 && { attachmentIds }),
      })
      if (!response.ok) { removeTmpMsg(); showToast('发送失败', 'error'); return }

      // F20260910ctlv 彻底切换：POST 发送流——单通道（entry.* / invoke.*；与常驻通道共用 handler 逻辑）
      // tmp 乐观消息由 entry.user 事件替换（同 id 幂等由后端保证——entryId 与 tmp id 不同，
      // 用户气泡以 tmp 呈现直到刷新；invoke 过程气泡走 entry.start/speak）
      const postHandlers: Record<string, (data: Record<string, unknown>) => void> = {
        'entry.user': (data) => {
          // F20260910ctlv 补漏：POST 流收到的 entry.user = 后端确认落库——替换 tmp 气泡
          //（真实 entryId + seq 接管排序；常驻通道同款去重逻辑幂等）
          const d = data as { entryId: string; sequenceNum?: number; senderId?: string; body?: string; createdAt?: string; yieldTargets?: string[] }
          batchUpdateMessages(activeId!, (current) => {
            if (current.some(m => m.id === d.entryId)) return current
            const realMsg: LocalMessage = {
              id: d.entryId, st: 'user', si: d.senderId || 'user',
              content: d.body ?? '', status: 'completed', seq: d.sequenceNum, ts: d.createdAt || nowTs(), dur: null,
              // F20260910ctlv 收尾：yieldTargets = 发言石目标（user 气泡「→ 目标」传递行）
              yieldTargets: d.yieldTargets ?? null,
            }
            const tmpIdx = [...current].reverse().findIndex(m =>
              m.id.startsWith('tmp-') && m.st === 'user' && m.content === realMsg.content)
            if (tmpIdx !== -1) {
              const idx = current.length - 1 - tmpIdx
              const next = [...current]
              next[idx] = realMsg
              return next
            }
            return [...current, realMsg]
          })
        },
        'entry.start': (data) => {
          const d = data as { entryId: string; invokeId?: string; otterId: string; otterName?: string; createdAt?: string }
          const placeholder: LocalMessage = {
            id: d.entryId, st: 'otter', si: d.otterId, sn: d.otterName,
            content: '', status: 'streaming', ts: d.createdAt || nowTs(), dur: null, events: [],
            invokeId: d.invokeId,
          }
          batchUpdateMessages(activeId!, (list) => insertBySeq(list, placeholder))
          if (d.otterId && activeId) {
            upsertOtterIfAbsentDeferred(d.otterId, d.otterName, activeId)
          }
        },
        'entry.speak': (data) => {
          const d = data as { entryId: string; body?: string; otterName?: string }
          if (!d.body) return
          batchUpdateMessages(activeId!, (list) => {
            if (!list.some(m => m.id === d.entryId)) return list
            return list.map(m => m.id === d.entryId ? { ...m, content: d.body ?? m.content, sn: m.sn || d.otterName || '' } : m)
          })
        },
        // F20260910ctlv 收尾：entry.complete 事件已退役（后端无发射点；speak 气泡终态由 invoke.end 收敛）
        'invoke.start': (data) => {
          const d = data as { invokeId: string; otterId: string; otterName?: string; triggerEntryId?: string; startedAt?: string }
          const startTs = d.startedAt || nowTs()
          const triggerEntryId = d.triggerEntryId
          if (triggerEntryId) {
            batchUpdateMessages(activeId!, (list) => insertCenteredByTs(list, {
              id: triggerEntryId, st: 'otter', si: d.otterId, sn: d.otterName,
              content: '', ts: startTs, dur: null,
              entryType: 'invoke_start', invokeId: d.invokeId, status: 'completed',
            }))
          }
        },
        'invoke.end': (data) => {
          const d = data as { invokeId: string; status: 'completed' | 'failed' | 'aborted' }
          batchUpdateMessages(activeId!, (list) => list.map(m =>
            m.invokeId === d.invokeId && isInFlight(m)
              ? { ...m, status: d.status === 'completed' ? 'completed' as const : d.status === 'aborted' ? 'aborted' as const : 'failed' as const, content: m.content || (d.status === 'completed' ? '' : d.status === 'aborted' ? '[中断]' : '[未完成]') }
              : m))
        },
        'entry.yield': (data) => {
          const d = data as { entryId: string; invokeId?: string; otterId?: string; otterName?: string; yieldTargets?: string[] }
          const targets = (d.yieldTargets || []).map((t: string) => ottersRef.current[activeId!]?.find(o => o.id === t)?.name || t)
          batchUpdateMessages(activeId!, (list) => insertCenteredByTs(list, {
            id: d.entryId, st: 'otter', si: d.otterId || '', sn: d.otterName,
            content: '', ts: nowTs(), dur: null,
            entryType: 'yield', invokeId: d.invokeId, yieldTargets: targets,
          }))
        },
        'entry.failed': (data) => {
          const d = data as { entryId: string; invokeId?: string; body?: string; otterId?: string; otterName?: string }
          const failedMsg: LocalMessage = {
            id: d.entryId, st: 'otter', si: d.otterId || '', sn: d.otterName,
            content: d.body ?? '[未完成]', status: 'failed', ts: nowTs(), dur: null,
            invokeId: d.invokeId,
          }
          batchUpdateMessages(activeId!, (list) => upsertTerminalMessage(list, failedMsg))
        },
        'entry.aborted': (data) => {
          const d = data as { entryId: string; invokeId?: string; body?: string; otterId?: string; otterName?: string }
          const abortedMsg: LocalMessage = {
            id: d.entryId, st: 'otter', si: d.otterId || '', sn: d.otterName,
            content: d.body ?? '[中断]', status: 'aborted', ts: nowTs(), dur: null,
            invokeId: d.invokeId,
          }
          batchUpdateMessages(activeId!, (list) => upsertTerminalMessage(list, abortedMsg))
          if (!abortNotifiedRef.current.has(d.entryId)) {
            abortNotifiedRef.current.add(d.entryId)
            showToast('回复已中断', 'info')
          }
        },
        'error': (data) => {
          const d = data as { message?: string; invokeId?: string; otterId?: string }
          showToast(`Agent 错误: ${d.message}`, 'error')
        },
        'entry.system': (data) => {
          const d = data as { entryId: string; content: string; seq?: number }
          const sysMsg: LocalMessage = {
            id: d.entryId, st: 'system', si: 'system', content: d.content,
            status: 'completed', seq: d.seq, ts: nowTs(), dur: null, entryType: 'system',
          }
          batchUpdateMessages(activeId!, (list) => insertBySeq(list, sysMsg))
        },
        'mention.feedback': (data) => {
          if ((data as { feedback?: string }).feedback) {
            showToast((data as { feedback: string }).feedback, 'info')
          }
        },
        'agent.idle': () => { /* 信息性事件 */ },
      }
      consumeSSE(response, postHandlers, { onError: () => {
        showToast('SSE 连接中断', 'error')
        /** SSE 中断不代表发言停止（刷新≠停止）：拉取快照播种进行中消息，让轮询续看接管 */
        if (activeId) refreshMessages(activeId)
      }, onDone: () => {
        /** 流结束后刷新参与者列表（agent 可能创建/解散了小獭）。
         *  F20260827scrf2：弹窗打开期间不 setState——结果延迟到关窗 flush（与 batcher
         *  同窗口）；非弹窗期行为不变（#502 浅比较保引用） */
        if (activeId) {
          api.getParticipants(activeId).then(participants => {
            const apply = (prev: Record<string, LocalOtter[]>) =>
              mergeOttersIfChanged(prev, activeId, participants.map(p => mapParticipantDTO(p)))
            runOrDefer(() => setAllOtters(apply))
          }).catch(() => {})
        }
      } })
    } catch (err) {
      console.error('Failed to send message:', err)
      removeTmpMsg()
      showToast('发送失败', 'error')
    }
  }, [activeId, refreshMessages, batchUpdateMessages, refreshParticipantsAfterDissolve, upsertOtterIfAbsentDeferred])

  /** 卡片提交 → 强制预览 → 回执复用 handleSend 整条 SSE 管线（显式路由卡片作者） */
  const { cardPreview, confirmCardPreview, rejectCardPreview } = useCardBridge({
    activeId,
    messages: activeMessages,
    onSendReply: (body, authorId) => { handleSend(body, authorId ? [authorId] : undefined) },
  })

  /** F20260910ctlv 彻底切换：停止按钮——abort invoke（invokeId 锚）。
   *  流式中的 speak 气泡保留（发言有效）；invoke 置 aborted 后右栏收敛。 */
  const stopStream = useCallback((messageId: string) => {
    if (!activeId) return
    const msgs = allMessagesRef.current[activeId] || []
    const target = msgs.find(m => m.id === messageId)
    const invokeId = target?.invokeId
    if (!invokeId) {
      showToast('找不到对应的执行记录，无法中断', 'error')
      return
    }
    /** 乐观置 aborted（即时反馈；服务端 invoke.end aborted 事件会收敛） */
    setAllMessages(prev => {
      const list = prev[activeId]
      if (!list?.some(m => m.id === messageId)) return prev
      return { ...prev, [activeId]: list.map(m => m.id === messageId && isInFlight(m)
        ? { ...m, status: 'aborted' as const, content: m.content || '[中断]' }
        : m) }
    })
    api.abortInvoke(invokeId, target?.si || '')
      .then(() => {
        showToast('已暂停本会话新任务，发新消息即恢复', 'info')
      })
      .catch((err) => console.error('Failed to abort invoke:', err))
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

  /** F20260910ctlv 彻底切换：手动重试——invoke retry（invokeId 锚）。
   *  重试产生全新 invoke（新时间线），流内 entry.* 事件插入新气泡。 */
  const handleRetryMessage = useCallback(async (messageId: string) => {
    if (!activeId) return
    const msgs = allMessagesRef.current[activeId] || []
    const target = msgs.find(m => m.id === messageId)
    const invokeId = target?.invokeId
    if (!invokeId) {
      showToast('找不到对应的执行记录，无法重试', 'error')
      return
    }
    try {
      const response = await api.retryInvoke(invokeId)
      if (!response.ok) { showToast('重试失败', 'error'); return }

      // 重试流：单通道 entry.*（与发送流同型；新 invoke 的气泡经 entry.start 插入）
      const retryHandlers: Record<string, (data: Record<string, unknown>) => void> = {
        'entry.start': (data) => {
          const d = data as { entryId: string; invokeId?: string; otterId: string; otterName?: string; createdAt?: string }
          const placeholder: LocalMessage = {
            id: d.entryId, st: 'otter', si: d.otterId, sn: d.otterName,
            content: '', status: 'streaming', ts: d.createdAt || nowTs(), dur: null, events: [],
            invokeId: d.invokeId,
          }
          batchUpdateMessages(activeId, (list) => insertBySeq(list, placeholder))
        },
        'entry.speak': (data) => {
          const d = data as { entryId: string; body?: string; otterName?: string }
          if (!d.body) return
          batchUpdateMessages(activeId, (list) => {
            if (!list.some(m => m.id === d.entryId)) return list
            return list.map(m => m.id === d.entryId ? { ...m, content: d.body ?? m.content, sn: m.sn || d.otterName || '' } : m)
          })
        },
        // F20260910ctlv 收尾：entry.complete 事件已退役（后端无发射点；speak 气泡终态由 invoke.end 收敛）
        'invoke.start': (data) => {
          const d = data as { invokeId: string; otterId: string; otterName?: string; triggerEntryId?: string; startedAt?: string }
          const startTs = d.startedAt || nowTs()
          const triggerEntryId = d.triggerEntryId
          if (triggerEntryId) {
            batchUpdateMessages(activeId, (list) => insertCenteredByTs(list, {
              id: triggerEntryId, st: 'otter', si: d.otterId, sn: d.otterName,
              content: '', ts: startTs, dur: null,
              entryType: 'invoke_start', invokeId: d.invokeId, status: 'completed',
            }))
          }
        },
        'invoke.end': (data) => {
          const d = data as { invokeId: string; status: 'completed' | 'failed' | 'aborted' }
          batchUpdateMessages(activeId, (list) => list.map(m =>
            m.invokeId === d.invokeId && isInFlight(m)
              ? { ...m, status: d.status === 'completed' ? 'completed' as const : d.status === 'aborted' ? 'aborted' as const : 'failed' as const, content: m.content || (d.status === 'completed' ? '' : d.status === 'aborted' ? '[中断]' : '[未完成]') }
              : m))
        },
        'entry.yield': (data) => {
          const d = data as { entryId: string; invokeId?: string; otterId?: string; otterName?: string; yieldTargets?: string[] }
          const targets = (d.yieldTargets || []).map((t: string) => ottersRef.current[activeId]?.find(o => o.id === t)?.name || t)
          batchUpdateMessages(activeId, (list) => insertCenteredByTs(list, {
            id: d.entryId, st: 'otter', si: d.otterId || '', sn: d.otterName,
            content: '', ts: nowTs(), dur: null,
            entryType: 'yield', invokeId: d.invokeId, yieldTargets: targets,
          }))
        },
        'entry.failed': (data) => {
          const d = data as { entryId: string; invokeId?: string; body?: string; otterId?: string; otterName?: string }
          batchUpdateMessages(activeId, (list) => list.map(m => m.id === d.entryId
            ? { ...m, status: 'failed' as const, content: d.body || m.content || '[未完成]' }
            : m))
        },
        'entry.aborted': (data) => {
          const d = data as { entryId: string; invokeId?: string; body?: string }
          batchUpdateMessages(activeId, (list) => list.map(m => m.id === d.entryId
            ? { ...m, status: 'aborted' as const, content: d.body || m.content || '[中断]' }
            : m))
        },
        'error': (data) => {
          showToast((data as { message?: string }).message || '重试出错', 'error')
        },
      }
      consumeSSE(response, retryHandlers)
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
  const handleCloseModal = useCallback(() => setModal({ type: 'none' }), [])
  const handleOpenRestart = useCallback((oid: string) => setModal({ type: 'restart', otterId: oid }), [])
  const handleOpenDissolve = useCallback((oid: string) => setModal({ type: 'dissolve', otterId: oid }), [])

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

  /** F20260827ucrt：创建小獭重写——重名前端预检 + 模型/头像自选 + 血缘交服务端诚实落 null */
  async function confirmCreateOtter(form: CreateOtterFormValue) {
    if (!activeId) return
    try {
      // T5：提交前预检在场同名（同名在场 toast 阻断，不发 POST；服务端无兜底，直接 API 调用不属目标场景）
      const participants = await api.getParticipants(activeId)
      const dup = participants.find(p => p.otterName === form.name)
      if (dup) {
        showToast(`在场已有同名小獭「${form.name}」，请换一个名字`, 'error')
        return
      }
      // T1：modelAlias 自选（空串 = 默认模型，不下发字段）；T4：不传 parentOtterId——
      // UI 创建的小獭没有獭召唤者，服务端血缘诚实落 null，前端不再猜测
      const dto = await api.createOtter({
        name: form.name,
        type: 'small',
        role: form.roleName || form.responsibilities.length > 0
          ? { name: form.roleName, responsibilities: form.responsibilities }
          : undefined,
        modelAlias: form.modelAlias || undefined,
        systemPrompt: form.systemPrompt,
      })
      // T2（前端版）：自选头像写 localStorage override（随机 = 不写，走 hash 池）
      if (form.avatarName) setOtterAvatarOverride(dto.id, form.avatarName)
      const otter = mapOtterDTO(dto)
      setAllOtters(prev => ({ ...prev, [activeId]: [...(prev[activeId] || []), otter] }))
      setModal({ type: 'none' }); showToast(`小獭 ${form.name} 已创建`, 'success')
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

  async function confirmRestart(summary: string, modelAlias?: string) {
    if (modal.type !== 'restart') return
    const otterId = modal.otterId
    try {
      await api.restartOtter(otterId, summary, modelAlias)
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

  return (
    <AppLayout activeView="index">
      {/* #500：三栏布局响应式降级——外层 relative 为窄屏抽屉提供定位上下文。
          断点策略（Tailwind 默认）：≥lg(1024px) 三栏全开；md(768px)~lg 右栏折叠为悬浮抽屉；
          <md 左右栏均抽屉化，聊天区独占。面板组件保持挂载（状态不丢），仅容器显隐。 */}
      <div className="relative flex flex-1 overflow-hidden p-3 gap-3">
        {/* 窄屏抽屉开关条：lg 以下显示。fixed 定位不挤压聊天区（issue 核心诉求）。 */}
        {!(isLgUp && isMdUp) && (
          <>
            {!isMdUp && (
              <button
                type="button"
                onClick={() => { setLeftDrawerOpen(o => !o); setRightDrawerOpen(false) }}
                aria-expanded={leftDrawerOpen}
                aria-controls="left-panel-drawer"
                aria-label={leftDrawerOpen ? '收起对话列表面板' : '展开对话列表面板'}
                className="fixed left-3 bottom-3 z-40 w-9 h-9 rounded-full glass-overlay flex items-center justify-center text-stone-500 hover:text-otter-500 transition shadow-bubble"
              >
                <PanelLeft className="w-4 h-4" />
              </button>
            )}
            {!isLgUp && (
              <button
                type="button"
                onClick={() => { setRightDrawerOpen(o => !o); setLeftDrawerOpen(false) }}
                aria-expanded={rightDrawerOpen}
                aria-controls="right-panel-drawer"
                aria-label={rightDrawerOpen ? '收起参与者面板' : '展开参与者面板'}
                className="fixed right-3 bottom-3 z-40 w-9 h-9 rounded-full glass-overlay flex items-center justify-center text-stone-500 hover:text-otter-500 transition shadow-bubble"
              >
                <PanelRight className="w-4 h-4" />
              </button>
            )}
          </>
        )}
        {/* 左栏：≥md 常驻；<md 抽屉化（absolute 悬浮，不挤压聊天区） */}
        <div
          id="left-panel-drawer"
          className={`${isMdUp ? 'contents' : `${leftDrawerOpen ? '' : 'hidden '}absolute left-3 top-3 bottom-3 z-50`}`}
        >
          <LeftPanel conversations={conversations} activeId={activeId || ''} onSelect={handleSelectConv} onNewConversation={handleNewConv} onContextMenu={handleContextMenu} otters={Object.values(allOtters).flat()} />
        </div>
        <ChatView conversation={activeConv} messages={activeMessages} state={pageState} onSend={handleSend} onStopStream={stopStream} onRetryMessage={handleRetryMessage} onRetry={() => { setPageState('normal'); showToast('正在重试...', 'info') }} onGoToSettings={() => { window.location.href = '/settings' }} onArchive={handleArchive} otters={activeOtters} conversationId={activeId || ''} isAtBottomRef={isAtBottomRef} newMessagesCount={newMessagesCount} onJumpToBottom={handleJumpToBottom} onLoadMore={loadMoreBefore} loadingMore={loadingMore} unreadSeparatorSeq={unreadSeparatorSeq} highlightMessageId={highlightMessageId} cardPreview={cardPreview} onConfirmCard={confirmCardPreview} onRejectCard={rejectCardPreview} userName={userName} onReachBottom={handleMarkRead} />
        {/* 右栏：≥lg 常驻；<lg 抽屉化。md~lg 区间聊天区 = 全宽 - 左栏(224px)，不再被右栏挤 <500px */}
        <div
          id="right-panel-drawer"
          className={`${isLgUp ? 'contents' : `${rightDrawerOpen ? '' : 'hidden '}absolute right-3 top-3 bottom-3 z-50`}`}
        >
          <RightPanel
          conversation={activeConv || conversations[0]}
          otters={activeOtters}
          sessions={sessions}
          invokeStates={invokeStates}
          onOpenSession={(otterId) => {
            const otter = (allOtters[activeId || ''] || []).find(o => o.id === otterId)
            if (otter) setSessionModalOtter(otter)
          }}
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
      </div>

      {ctxMenu && activeConvForMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeCtxMenu} />
          <div className="fixed glass-overlay rounded-2xl p-1 z-50 min-w-[150px]" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <div onClick={() => ctxAction(activeConvForMenu.pinned ? 'unpin' : 'pin', ctxMenu.cid)} className="px-2.5 py-1.5 rounded-lg text-xs cursor-pointer hover:bg-white/40 text-stone-600">{activeConvForMenu.pinned ? '取消置顶' : '置顶'}</div>
            <div onClick={() => ctxAction('archive', ctxMenu.cid)} className={`px-2.5 py-1.5 rounded-lg text-xs cursor-pointer ${activeConvForMenu.status !== 'archived' ? 'hover:bg-white/40 text-stone-600' : 'text-stone-300 cursor-not-allowed'}`}>归档对话</div>
          </div>
        </>
      )}

      <ConversationModals modal={modal} otters={activeOtters} sessions={sessions} onClose={handleCloseModal} onConfirmNewConv={confirmNewConv} onConfirmArchive={confirmArchive} onConfirmCreateOtter={confirmCreateOtter} onConfirmDissolve={confirmDissolve} onConfirmRestart={confirmRestart} onConfirmLinkResource={confirmLinkResource} onOpenRestart={handleOpenRestart} onOpenDissolve={handleOpenDissolve} />

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

      {/* F20260910ctlv：Session 弹窗（獭 invoke 历史 + 流式过程） */}
      {sessionModalOtter && (
        <SessionModal otter={sessionModalOtter} conversationId={activeId || ''} onClose={() => setSessionModalOtter(null)} />
      )}
    </AppLayout>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<ConversationPage />)
