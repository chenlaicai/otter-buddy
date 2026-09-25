import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, ArrowUpRight, Loader2 } from 'lucide-react'
import * as api from '../../api/client'
import { consumeSSE } from '../../api/sse'
import { showToast } from '../Toast'
import { nowTs } from '../../lib/utils'

/**
 * F20260924wast：浮层对话面板（380×520）。
 * 消息流（HTTP sendMessage + POST SSE 流式）+ 输入框 + 「完整对话 ↗」跳转。
 * 一期纯文本渲染（非目标：富内容 html-card）；无上下文 chip（T4 已砍）。
 * session 状态：一期展示轮换提示文案（剩余时长二期补——方案未决 1）。
 */

export interface AssistantPanelProps {
  /** 宿主定位（fixed top/right——直接挂面板根元素，避免零尺寸容器锚点偏移） */
  style?: React.CSSProperties
  conversationId: string | null
  /** 首唤开户中（loading 态） */
  ensuring: boolean
  /** 开户失败提示（重试入口） */
  ensureError: string | null
  onRetryEnsure: () => void
  onClose: () => void
  /** 快捷问句预填（宿主传入，消费后清空） */
  initialDraft: string | null
  onDraftConsumed: () => void
}

interface PanelMessage {
  id: string
  /** user | otter | system */
  st: 'user' | 'otter' | 'system'
  content: string
  ts: string
}

export function AssistantPanel(props: AssistantPanelProps) {
  const { conversationId, ensuring, ensureError, onRetryEnsure, onClose, initialDraft, onDraftConsumed, style } = props
  const navigate = useNavigate()
  const [messages, setMessages] = useState<PanelMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // 历史加载（面板打开 + conversationId 就绪时）
  useEffect(() => {
    if (!conversationId) { setMessages([]); setHistoryLoaded(false); return }
    let cancelled = false
    api.listEntries(conversationId, 30).then(({ entries }) => {
      if (cancelled) return
      // 倒序转正序；只渲染 user/speak/system 三类（invoke 边界一期略——面板轻量）
      const view: PanelMessage[] = [...entries].reverse()
        .filter(e => e.entryType === 'user' || e.entryType === 'speak' || e.entryType === 'system')
        .map(e => ({
          id: e.id,
          st: e.entryType === 'user' ? 'user' : e.entryType === 'speak' ? 'otter' : 'system',
          content: e.body ?? '',
          ts: e.createdAt,
        }))
      setMessages(view)
      setHistoryLoaded(true)
    }).catch(() => { if (!cancelled) setHistoryLoaded(true) })
    return () => { cancelled = true }
  }, [conversationId])

  // 快捷问句预填
  useEffect(() => {
    if (initialDraft) {
      setInput(initialDraft)
      onDraftConsumed()
      inputRef.current?.focus()
    }
  }, [initialDraft, onDraftConsumed])

  // 自动滚底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || !conversationId || sending) return
    setSending(true)
    setInput('')
    const tmpId = 'tmp-' + Date.now()
    setMessages(prev => [...prev, { id: tmpId, st: 'user', content: text, ts: nowTs() }])
    try {
      const response = await api.sendMessage(conversationId, {
        senderId: 'user', talkingStonePassedTo: [], body: text,
      })
      if (!response.ok) {
        setMessages(prev => prev.filter(m => m.id !== tmpId))
        showToast('发送失败', 'error')
        return
      }
      // POST SSE 流：entry.speak（獭回复气泡）落流式渲染；stream.end 关闭
      await consumeSSE(response, {
        'entry.user': data => {
          const d = data as { entryId: string; body?: string }
          setMessages(prev => prev.map(m => (m.id === tmpId ? { ...m, id: d.entryId, content: d.body ?? m.content } : m)))
        },
        'entry.speak': data => {
          const d = data as { entryId: string; body?: string; otterName?: string; createdAt?: string }
          if (!d.body) return
          const body: string = d.body
          const createdAt: string = d.createdAt || nowTs()
          setMessages(prev => {
            if (prev.some(m => m.id === d.entryId)) return prev
            return [...prev, { id: d.entryId, st: 'otter' as const, content: body, ts: createdAt }]
          })
        },
        'entry.system': data => {
          const d = data as { entryId: string; content?: string }
          setMessages(prev => {
            if (prev.some(m => m.id === d.entryId)) return prev
            return [...prev, { id: d.entryId, st: 'system', content: d.content ?? '', ts: nowTs() }]
          })
        },
        error: data => {
          const d = data as { message?: string }
          showToast(d.message || '回复失败', 'error')
        },
      })
    } catch {
      setMessages(prev => prev.filter(m => m.id !== tmpId))
      showToast('发送失败', 'error')
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }, [input, conversationId, sending])

  return (
    <div
      data-testid="assistant-panel"
      role="dialog"
      aria-label="web 助理面板"
      style={style}
      className="fixed z-50 w-[380px] h-[520px] rounded-3xl bg-white/95 backdrop-blur shadow-2xl
        border border-white/60 flex flex-col overflow-hidden animate-otter-pop"
    >
      {/* 头部：标题 + session 提示 + 跳转 + 关闭 */}
      <div className="px-4 py-3 border-b border-stone-100 flex items-center gap-2 flex-shrink-0">
        <img src="/avatars/datu.svg" alt="" className="w-6 h-6" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-stone-700">web 助理</div>
          <div className="text-[10px] text-stone-400">静默 8 小时自动开新 session</div>
        </div>
        <button
          type="button"
          data-testid="assistant-panel-full"
          className="w-7 h-7 rounded-xl flex items-center justify-center text-stone-400 hover:bg-stone-100 transition"
          title="完整对话"
          onClick={() => conversationId && navigate(`/conversation/${conversationId}`)}
        >
          <ArrowUpRight className="w-4 h-4" />
        </button>
        <button
          type="button"
          data-testid="assistant-panel-close"
          className="w-7 h-7 rounded-xl flex items-center justify-center text-stone-400 hover:bg-stone-100 transition"
          title="收起（Esc）"
          onClick={onClose}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 消息流 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
        {ensuring && (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-stone-400">
            <Loader2 className="w-5 h-5 animate-spin" />
            <div className="text-xs">正在唤起 web 助理…</div>
          </div>
        )}
        {ensureError && !ensuring && (
          <div className="flex flex-col items-center gap-3 py-10">
            <div className="text-xs text-red-500">{ensureError}</div>
            <button type="button" onClick={onRetryEnsure} className="text-xs text-teal-600 hover:underline">重试</button>
          </div>
        )}
        {!ensuring && !ensureError && historyLoaded && messages.length === 0 && (
          <div className="py-10 text-center text-xs text-stone-400">
            随口问点什么——这是全局随问入口，问完就收
          </div>
        )}
        {messages.map(m =>
          m.st === 'system' ? (
            <div key={m.id} className="text-center text-[10px] text-stone-400 py-1">{m.content}</div>
          ) : m.st === 'user' ? (
            <div key={m.id} className="flex justify-end">
              <div data-testid="assistant-panel-user-msg" className="max-w-[80%] rounded-2xl rounded-br-md bg-teal-500 text-white px-3 py-2 text-xs whitespace-pre-wrap break-words">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex items-start gap-2">
              <img src="/avatars/datu.svg" alt="" className="w-5 h-5 mt-0.5 rounded bg-stone-50" />
              <div data-testid="assistant-panel-otter-msg" className="max-w-[80%] rounded-2xl rounded-bl-md bg-stone-100 text-stone-700 px-3 py-2 text-xs whitespace-pre-wrap break-words">
                {m.content}
              </div>
            </div>
          ),
        )}
        {sending && messages[messages.length - 1]?.st !== 'user' && (
          <div className="flex items-start gap-2">
            <img src="/avatars/datu.svg" alt="" className="w-5 h-5 mt-0.5 rounded bg-stone-50" />
            <div className="rounded-2xl rounded-bl-md bg-stone-100 px-3 py-2 text-xs text-stone-400">思考中…</div>
          </div>
        )}
      </div>

      {/* 输入框 */}
      <div className="p-3 border-t border-stone-100 flex-shrink-0">
        <div className="flex items-end gap-2 rounded-2xl bg-stone-100 px-3 py-2">
          <textarea
            ref={inputRef}
            data-testid="assistant-panel-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            rows={2}
            placeholder={conversationId ? '随口问点什么…（Enter 发送）' : '正在唤起助理…'}
            disabled={!conversationId || ensuring}
            className="flex-1 bg-transparent text-xs text-stone-700 outline-none resize-none placeholder:text-stone-400 disabled:opacity-50"
          />
          <button
            type="button"
            data-testid="assistant-panel-send"
            onClick={() => void send()}
            disabled={!input.trim() || !conversationId || sending}
            className="w-7 h-7 rounded-xl bg-teal-500 text-white flex items-center justify-center disabled:opacity-40 hover:bg-teal-600 transition flex-shrink-0"
            aria-label="发送"
          >
            <ArrowUpRight className="w-4 h-4 rotate-45" />
          </button>
        </div>
      </div>
    </div>
  )
}

export default AssistantPanel
