import { type RefObject } from 'react'
import { Archive, ShieldAlert } from 'lucide-react'
import type { LocalConversation as Conversation, LocalOtter as Otter, LocalMessage as Message } from '../../lib/mappers'
import type { CardPreview } from './hooks/useCardBridge'
import { MessageList } from './MessageList'
import { MessageInput } from './MessageInput'

interface ChatViewProps {
  conversation: Conversation | null
  messages: Message[]
  state: 'normal' | 'empty' | 'loading' | 'error' | 'no-llm'
  onSend: (text: string, mentionOtterIds?: string[]) => void
  onStopStream: (messageId: string) => void
  onRetryMessage: (messageId: string) => void
  onRetry: () => void
  onGoToSettings: () => void
  onArchive: () => void
  otters: Otter[]
  // 滚动 props 透传
  conversationId: string
  isAtBottomRef: RefObject<boolean>
  newMessagesCount?: number
  onJumpToBottom?: () => void
  onLoadMore?: () => void
  loadingMore?: boolean
  unreadSeparatorSeq?: number | null
  highlightMessageId?: string | null
  /** 用户在设置中配置的称呼 */
  userName?: string
  /** 卡片提交待确认预览（输入框上方单槽位） */
  cardPreview?: CardPreview | null
  onConfirmCard?: () => void
  onRejectCard?: () => void
  /** 用户滚动到底部时调用，用于标记已读 */
  onReachBottom?: () => void
}

export function ChatView(props: ChatViewProps) {
  const { conversation: c } = props

  return (
    <main className="flex-1 glass rounded-3xl flex flex-col overflow-hidden">
      {/* Chat Header */}
      <div className="px-1 py-3 flex items-center justify-between border-b border-white/40 flex-shrink-0">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold text-stone-700">{c?.title || '对话'}</h1>
          {c && (
            <span
              className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                c.status === 'active'
                  ? 'bg-teal-400/15 text-teal-500'
                  : c.status === 'completed'
                  ? 'bg-otter-400/15 text-otter-500'
                  : 'bg-stone-400/15 text-stone-400'
              }`}
            >
              {c.status === 'active' ? '活跃' : c.status === 'completed' ? '已完成' : '已归档'}
            </span>
          )}
        </div>
        {c && (
          <div className="flex gap-1.5">
            <button
              onClick={props.onArchive}
              disabled={c.status === 'archived'}
              className="px-2.5 py-1 text-xs font-medium rounded-lg glass-card text-stone-600 hover:bg-white/50 transition flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Archive className="w-3 h-3" /> 归档
            </button>
          </div>
        )}
      </div>

      {/* Message List */}
      <MessageList
        messages={props.messages}
        state={props.state}
        onStopStream={props.onStopStream}
        onRetryMessage={props.onRetryMessage}
        onRetry={props.onRetry}
        onGoToSettings={props.onGoToSettings}
        otters={props.otters}
        conversationId={props.conversationId}
        isAtBottomRef={props.isAtBottomRef}
        newMessagesCount={props.newMessagesCount}
        onJumpToBottom={props.onJumpToBottom}
        onLoadMore={props.onLoadMore}
        loadingMore={props.loadingMore}
        unreadSeparatorSeq={props.unreadSeparatorSeq}
        highlightMessageId={props.highlightMessageId}
        userName={props.userName}
        onReachBottom={props.onReachBottom}
      />

      {/* 卡片提交预览槽位（强制且永久，无直接发送开关）：summary 全文 + data JSON 全文默认可见 */}
      {props.cardPreview && (
        <div className="mx-1 mb-2 rounded-2xl border border-amber-200/60 bg-amber-50/60 px-4 py-3 flex-shrink-0">
          <div className="flex items-start gap-1.5 text-[11px] text-amber-700 mb-2">
            <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>以下内容由水獭卡片生成，请核对后发送；已提交的卡片不可重复提交，修改答案请让水獭重发新卡</span>
          </div>
          <div className="text-sm text-stone-700 whitespace-pre-wrap break-all mb-2">{props.cardPreview.summary}</div>
          {props.cardPreview.dataJson !== null && (
            <details open className="mb-2">
              <summary className="text-[11px] text-stone-500 cursor-pointer select-none">数据 JSON（全文）</summary>
              <pre className="mt-1 text-[11px] text-stone-500 bg-white/60 rounded-lg px-3 py-2 whitespace-pre-wrap break-all max-h-[240px] overflow-y-auto">{props.cardPreview.dataJson}</pre>
            </details>
          )}
          <div className="flex gap-2">
            <button
              onClick={props.onConfirmCard}
              className="px-3 py-1 text-xs font-medium text-white rounded-xl shadow-glow transition"
              style={{ background: 'linear-gradient(135deg,#A88260,#8B6F47)' }}
            >
              发送
            </button>
            <button
              onClick={props.onRejectCard}
              className="px-3 py-1 text-xs glass-card text-stone-500 rounded-xl transition hover:bg-white/50"
            >
              拒绝
            </button>
          </div>
        </div>
      )}

      {/* Input */}
      <MessageInput
        onSend={props.onSend}
        disabled={c?.status === 'archived'}
        otters={props.otters}
      />
    </main>
  )
}
