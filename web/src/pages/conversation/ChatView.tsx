import { FilePlus, Check, Archive } from 'lucide-react'
import type { Conversation, Otter } from '../../mock/data'
import { MessageList, type StreamingState } from './MessageList'
import { MessageInput } from './MessageInput'

interface ChatViewProps {
  conversation: Conversation | null
  messages: import('../../mock/data').Message[]
  streamingMessage: StreamingState | null
  state: 'normal' | 'empty' | 'loading' | 'error' | 'no-llm'
  onSend: (text: string, mentionOtterId?: string) => void
  onStopStream: () => void
  onRetry: () => void
  onGoToSettings: () => void
  onCreateChild: () => void
  onComplete: () => void
  onArchive: () => void
  otters: Otter[]
}

export function ChatView(props: ChatViewProps) {
  const { conversation: c } = props

  return (
    <main className="flex-1 glass rounded-3xl flex flex-col overflow-hidden">
      {/* Chat Header */}
      <div className="px-6 py-3 flex items-center justify-between border-b border-white/40 flex-shrink-0">
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
              onClick={props.onCreateChild}
              className="px-2.5 py-1 text-xs font-medium rounded-lg glass-card text-stone-600 hover:bg-white/50 transition flex items-center gap-1"
            >
              <FilePlus className="w-3 h-3" /> 子对话
            </button>
            <button
              onClick={props.onComplete}
              disabled={c.status !== 'active'}
              className="px-2.5 py-1 text-xs font-medium rounded-lg glass-card text-stone-600 hover:bg-white/50 transition flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Check className="w-3 h-3" /> 完成
            </button>
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
        streamingMessage={props.streamingMessage}
        state={props.state}
        onStopStream={props.onStopStream}
        onRetry={props.onRetry}
        onGoToSettings={props.onGoToSettings}
      />

      {/* Input */}
      <MessageInput
        onSend={props.onSend}
        disabled={c?.status === 'archived'}
        otters={props.otters}
      />
    </main>
  )
}
