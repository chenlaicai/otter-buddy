import { useCallback, useEffect, useRef, useState } from 'react'
import type { LocalMessage } from '../../../lib/mappers'
import {
  CARD_MAX_HEIGHT,
  CARD_MIN_HEIGHT,
  buildCardReplyBody,
  countCardFences,
  deriveRepliedCardIds,
  validateCardSubmitPayload,
} from '../../../lib/html-card'
import { getCardEntry, getCardIdByWindow } from '../../../lib/card-registry'
import { showToast } from '../../../components/Toast'

/** 待确认的卡片提交（输入框上方单槽位预览） */
export interface CardPreview {
  cardId: string
  /** 卡片作者 senderId（回执显式路由目标） */
  authorId: string
  summary: string
  /** data JSON 全文（预览默认可见）；无 data 时为 null */
  dataJson: string | null
  /** 原始 data（构造回执用） */
  data: unknown
}

interface UseCardBridgeOptions {
  activeId: string | null
  messages: LocalMessage[]
  /** 复用 handleSend 整条 SSE 管线（乐观 tmp + consumeSSE + 轮询兜底） */
  onSendReply: (body: string, authorId: string) => void
}

/** resize 节流间隔（布局 DoS 防线之一，另一道是 clamp） */
const RESIZE_THROTTLE_MS = 60
/** submit 节流间隔（per-card，防脚本高频轰炸预览闸门） */
const SUBMIT_THROTTLE_MS = 200
/** 连续拒绝次数上限：达到后该卡 submit 会话内关闭（防脚本打地鼠；刷新后重置，预览闸门仍在） */
const MAX_REJECTS = 3

/** 挂起预览存活判据：cardId 对应消息的 body 仍含该围栏。
 *  用户收起卡片（iframe unmount）不丢预览；failMessage/aborted 整体替换 body 才丢弃 */
function cardFencePresent(messages: LocalMessage[], cardId: string): boolean {
  const sep = cardId.lastIndexOf(':')
  if (sep <= 0) return false
  const fenceIndex = Number(cardId.slice(sep + 1))
  if (!Number.isInteger(fenceIndex) || fenceIndex < 0) return false
  const msg = messages.find(m => m.id === cardId.slice(0, sep))
  if (!msg) return false
  return fenceIndex < countCardFences(msg.content)
}

/** 卡片桥消息监听 + 父页校验链 + 强制预览。
 *  威胁前提：桥无法区分真人点击与 AI 脚本自动调用，summary 由 AI 措辞——预览是唯一闸门，强制且永久 */
export function useCardBridge({ activeId, messages, onSendReply }: UseCardBridgeOptions) {
  const [preview, setPreview] = useState<CardPreview | null>(null)
  /** ref 穿透：message 监听只注册一次，闭包内读最新状态 */
  const previewRef = useRef(preview)
  previewRef.current = preview
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const onSendReplyRef = useRef(onSendReply)
  onSendReplyRef.current = onSendReply
  /** 会话内状态（刷新重置）：各卡拒绝计数 / 已关闭的卡 / resize、submit 节流时间戳 */
  const rejectCountsRef = useRef(new Map<string, number>())
  const closedCardsRef = useRef(new Set<string>())
  const lastResizeRef = useRef(new Map<string, number>())
  const lastSubmitRef = useRef(new Map<string, number>())
  /** derive 缓存：按 messages 引用记忆化（message 事件里不重扫） */
  const repliedCacheRef = useRef<{ messages: LocalMessage[]; ids: Set<string> } | null>(null)
  const getRepliedIds = () => {
    if (repliedCacheRef.current?.messages !== messagesRef.current) {
      repliedCacheRef.current = { messages: messagesRef.current, ids: deriveRepliedCardIds(messagesRef.current) }
    }
    return repliedCacheRef.current.ids
  }

  /** 切会话即丢弃待确认预览（预览为输入框上方单槽位，跨会话不存在并发） */
  useEffect(() => {
    setPreview(null)
  }, [activeId])

  /** 挂起预览的自动丢弃：发送成功（已回复集合历史派生覆盖）或卡片围栏从消息体消失
   *  （failMessage/aborted 整体替换 body）。用户收起卡片（iframe unmount、registry 注销）不丢弃 */
  useEffect(() => {
    if (!preview) return
    if (getRepliedIds().has(preview.cardId) || !cardFencePresent(messages, preview.cardId)) {
      setPreview(null)
    }
  }, [messages, preview])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; cardId?: unknown; height?: unknown; payload?: unknown } | null
      if (!data || typeof data !== 'object') return
      // type 白名单
      if (data.type !== 'card:resize' && data.type !== 'card:submit') return
      // source 白名单 + iframe→cardId 映射匹配（伪造提交/冒充他卡在此拦截）
      const sourceCardId = getCardIdByWindow(event.source as Window)
      if (!sourceCardId || sourceCardId !== data.cardId) return
      const cardId = sourceCardId

      if (data.type === 'card:resize') {
        const h = Number(data.height)
        if (!Number.isFinite(h)) return
        const now = Date.now()
        if (now - (lastResizeRef.current.get(cardId) || 0) < RESIZE_THROTTLE_MS) return
        lastResizeRef.current.set(cardId, now)
        const clamped = Math.min(CARD_MAX_HEIGHT, Math.max(CARD_MIN_HEIGHT, Math.round(h)))
        getCardEntry(cardId)?.setHeight?.(clamped)
        return
      }

      // card:submit：per-card 节流（防脚本高频轰炸预览闸门）
      const now = Date.now()
      if (now - (lastSubmitRef.current.get(cardId) || 0) < SUBMIT_THROTTLE_MS) return
      lastSubmitRef.current.set(cardId, now)
      if (closedCardsRef.current.has(cardId)) return
      // 已回复集合（历史派生，按 messages 引用缓存）：发送成功过的 cardId 永久关闭，改答案请让水獭重发新卡
      if (getRepliedIds().has(cardId)) return
      // payload 形状校验（500 字符 / 2KB / 禁循环引用与函数）
      if (!validateCardSubmitPayload(data.payload).ok) return
      const current = previewRef.current
      if (current) {
        // 预览挂起期间同卡 submit 直接丢弃
        if (current.cardId === cardId) return
        // A 卡挂起时 B 卡提交：拒绝并提示（单槽位）
        showToast('请先处理当前待确认的卡片提交', 'info')
        return
      }
      const entry = getCardEntry(cardId)
      if (!entry) return
      const payload = data.payload as { summary: string; data?: unknown }
      setPreview({
        cardId,
        authorId: entry.authorId,
        summary: payload.summary,
        dataJson: payload.data === undefined ? null : JSON.stringify(payload.data, null, 2),
        data: payload.data,
      })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  /** 确认：构造回执 body（summary + html-card-reply 围栏）→ 显式路由卡片作者 → 复用发送管线 */
  const confirmPreview = useCallback(() => {
    const p = previewRef.current
    if (!p) return
    setPreview(null)
    onSendReplyRef.current(buildCardReplyBody(p.summary, p.cardId, p.data), p.authorId)
  }, [])

  /** 拒绝：重置该卡提交闸（可修正重提）；连续 3 次拒绝该卡 submit 会话内关闭 */
  const rejectPreview = useCallback(() => {
    const p = previewRef.current
    if (!p) return
    setPreview(null)
    const n = (rejectCountsRef.current.get(p.cardId) || 0) + 1
    rejectCountsRef.current.set(p.cardId, n)
    if (n >= MAX_REJECTS) {
      closedCardsRef.current.add(p.cardId)
      showToast('该卡片提交已关闭（连续拒绝 3 次）', 'info')
    }
  }, [])

  return { cardPreview: preview, confirmCardPreview: confirmPreview, rejectCardPreview: rejectPreview }
}
