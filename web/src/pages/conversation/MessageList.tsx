import { useRef, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { AlertTriangle, Square } from 'lucide-react'
import type { LocalMessage as Message, LocalOtter as Otter, LocalMessageEvent } from '../../lib/mappers'
import { getOtterColor, OTTER_GRADIENT } from '../../lib/otter-colors'
import { fmtTokens, ctxPercent } from '../../lib/utils'

interface MessageListProps {
  messages: Message[]
  streamingMessage: StreamingState | null
  state: 'normal' | 'empty' | 'loading' | 'error' | 'no-llm'
  onStopStream: () => void
  onRetry: () => void
  onGoToSettings: () => void
  otters: Otter[]
}

export interface StreamingState {
  otterId: string
  streamingText: string
  finalText: string
  showFinal: boolean
  duration: number
}

export function MessageList({ messages, streamingMessage, state, onStopStream, onRetry, onGoToSettings, otters }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, streamingMessage])

  if (state === 'no-llm') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3.5">
        <AlertTriangle className="w-12 h-12 text-stone-300" />
        <div className="text-base font-semibold text-stone-600">请先配置 LLM</div>
        <div className="text-sm text-stone-400 text-center max-w-xs leading-relaxed">
          系统需要 LLM API Key 才能工作。<br />请前往设置页面配置。
        </div>
        <button
          onClick={onGoToSettings}
          className="px-4 py-2 text-sm text-white rounded-2xl shadow-glow transition flex items-center gap-1.5"
          style={{ background: OTTER_GRADIENT }}
        >
          前往设置
        </button>
      </div>
    )
  }

  if (state === 'loading') {
    return (
      <div className="max-w-[780px] mx-auto px-6">
        <div className="h-14 mb-2 rounded-3xl bg-white/30 animate-pulse" />
        <div className="h-14 mb-2 rounded-3xl bg-white/30 animate-pulse" />
        <div className="h-14 rounded-3xl bg-white/30 animate-pulse" />
      </div>
    )
  }

  if (messages.length === 0 && !streamingMessage) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-stone-300 gap-2">
        <div className="text-sm font-medium text-stone-400">开始对话</div>
        <div className="text-xs text-stone-400">在下方输入消息开始与大獭对话</div>
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto py-4">
      {messages.map(m => (
        <MessageItem key={m.id} message={m} otters={otters} />
      ))}
      {streamingMessage && (
        <StreamingMessage state={streamingMessage} onStop={onStopStream} otters={otters} />
      )}
      {state === 'error' && (
        <div className="max-w-[780px] mx-auto px-6 my-2">
          <div className="bg-red-400/10 border border-red-400/20 rounded-2xl px-4 py-2.5 flex items-center gap-2 text-sm text-red-500">
            <AlertTriangle className="w-4 h-4" />
            <span>LLM 调用失败：API Key 无效</span>
            <button
              onClick={onRetry}
              className="ml-auto px-2.5 py-1 border border-red-400/30 rounded-lg text-xs font-medium hover:bg-red-400 hover:text-white transition"
            >
              重试
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function MessageItem({ message: m, otters }: { message: Message; otters: Otter[] }) {
  const isUser = m.st === 'user'
  const otter = isUser ? null : otters.find(o => o.id === m.si)
  const name = isUser ? '我' : (otter?.name || 'Otter')
  const color = isUser ? null : getOtterColor(m.si, otter?.ci)
  const bgGrad = isUser ? 'linear-gradient(135deg,#8B7E72,#6B6157)' : color?.gradient
  const nameColor = isUser ? 'text-stone-400' : color?.nameClass || 'text-otter-500'
  const borderLeft = !isUser ? { borderLeft: `3px solid ${color?.border || '#8B6F47'}` } : {}
  const dur = m.dur ? ` · ${m.dur}` : ''

  return (
    <div className={`flex gap-2.5 max-w-[780px] mx-auto mb-4 px-6 animate-slideIn ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0 mt-0.5 shadow-bubble"
        style={{ background: bgGrad }}
      >
        {isUser ? '我' : (otter?.name?.charAt(0) || 'O')}
      </div>
      <div className={`flex flex-col ${isUser ? 'items-end' : ''}`} style={{ maxWidth: '72%' }}>
        <div className="flex items-center gap-1.5 mb-1 px-1">
          <span className={`text-xs font-semibold ${nameColor}`}>{name}</span>
          <span className="text-[11px] text-stone-300">{m.ts}{dur}</span>
        </div>
        <div
          className={`msg-content rounded-3xl px-4 py-2.5 text-sm leading-relaxed shadow-bubble ${
            isUser ? 'bubble-user text-white' : 'bubble-otter bg-white text-stone-700 border border-stone-100'
          }`}
          style={isUser ? { background: bgGrad } : borderLeft}
        >
          {!isUser && m.events && m.events.length > 0 && <StreamingProcess events={m.events} duration={m.dur || ''} />}
          <ReactMarkdown>{m.content}</ReactMarkdown>
        </div>
        {!isUser && (
          <div className="flex items-center gap-1.5 mt-1.5 px-1 text-[10px] text-stone-400">
            <span>{fmtTokens(m.ctx || 0)} / {fmtTokens(m.ctxMax || 200000)}</span>
            <div className="w-20 h-0.5 rounded-full" style={{ background: 'rgba(139,111,71,0.1)' }}>
              <div
                className="h-full rounded-full"
                style={{ width: `${ctxPercent(m.ctx || 0, m.ctxMax || 200000)}%`, background: '#8B6F47' }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function StreamingProcess({ events, duration }: { events: LocalMessageEvent[]; duration: string }) {
  const [collapsed, setCollapsed] = useState(true)

  return (
    <div className="streaming-section mb-2 rounded-xl overflow-hidden" style={{ background: 'rgba(139,111,71,0.04)', border: '1px solid rgba(139,111,71,0.08)' }}>
      <div
        className="flex items-center gap-1.5 px-3 py-1.5 cursor-pointer hover:bg-white/30 transition"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className={`streaming-icon text-[8px] text-stone-400 transition ${collapsed ? '' : 'rotate-180'}`}>▼</span>
        <span className="text-[11px] text-stone-500 font-medium flex-1">流式过程 · {events.length} 个事件</span>
        <span className="text-[10px] text-stone-400">已完成 · {duration}</span>
      </div>
      {!collapsed && (
        <div className="streaming-body border-t border-otter-200/20 max-h-[400px] overflow-y-auto">
          {events.map((evt, i) => <EventItem key={i} event={evt} />)}
        </div>
      )}
    </div>
  )
}

function EventItem({ event }: { event: LocalMessageEvent }) {
  const { eventType, payload } = event

  if (eventType === 'tool_call') {
    return (
      <div className="flex items-start gap-2 px-3 py-1.5 border-b border-stone-100 last:border-0">
        <span className="text-teal-500 text-[11px] mt-0.5">▶</span>
        <div className="flex-1 min-w-0">
          <span className="text-[11px] font-medium text-stone-600">调用 {payload.name}</span>
        </div>
      </div>
    )
  }

  if (eventType === 'tool_result') {
    const resultText = typeof payload.result === 'object' && payload.result !== null
      ? (payload.result as { content?: Array<{ text?: string }> }).content?.[0]?.text || JSON.stringify(payload.result)
      : String(payload.result)
    const preview = resultText.length > 200 ? resultText.slice(0, 200) + '...' : resultText
    return (
      <div className="flex items-start gap-2 px-3 py-1.5 border-b border-stone-100 last:border-0">
        <span className="text-stone-400 text-[11px] mt-0.5">◀</span>
        <div className="flex-1 min-w-0">
          <span className="text-[11px] text-stone-400">{payload.name}</span>
          <pre className="text-[10px] text-stone-500 mt-0.5 whitespace-pre-wrap break-all bg-stone-50 rounded px-2 py-1 max-h-[120px] overflow-y-auto">{preview}</pre>
        </div>
      </div>
    )
  }

  if (eventType === 'assistant_toolcall') {
    const content = payload.content as Array<Record<string, unknown>> | undefined
    const toolCall = content?.find(c => c.type === 'toolCall')
    const thinking = content?.find(c => c.type === 'thinking')
    return (
      <div className="flex items-start gap-2 px-3 py-1.5 border-b border-stone-100 last:border-0">
        <span className="text-amber-500 text-[11px] mt-0.5">⚡</span>
        <div className="flex-1 min-w-0">
          <span className="text-[11px] font-medium text-stone-600">决策：调用 {(toolCall as Record<string, unknown>)?.toolName || '工具'}</span>
          {thinking && <span className="text-[10px] text-stone-400 ml-2">（含思考）</span>}
        </div>
      </div>
    )
  }

  if (eventType === 'assistant_text') {
    const content = payload.content as Array<Record<string, unknown>> | undefined
    const text = content?.find(c => c.type === 'text')
    const preview = ((text?.text as string) || '').length > 100
      ? ((text?.text as string) || '').slice(0, 100) + '...'
      : (text?.text as string) || ''
    return (
      <div className="flex items-start gap-2 px-3 py-1.5 border-b border-stone-100 last:border-0">
        <span className="text-blue-500 text-[11px] mt-0.5">💬</span>
        <div className="flex-1 min-w-0">
          <span className="text-[11px] font-medium text-stone-600">输出</span>
          {preview && <div className="text-[10px] text-stone-500 mt-0.5">{preview}</div>}
        </div>
      </div>
    )
  }

  if (eventType === 'error') {
    return (
      <div className="flex items-start gap-2 px-3 py-1.5 border-b border-stone-100 last:border-0">
        <span className="text-red-500 text-[11px] mt-0.5">✗</span>
        <div className="flex-1 min-w-0">
          <span className="text-[11px] font-medium text-red-600">{payload.message}</span>
        </div>
      </div>
    )
  }

  return null
}

function StreamingMessage({ state, onStop, otters }: { state: StreamingState; onStop: () => void; otters: Otter[] }) {
  const otter = otters.find(o => o.id === state.otterId)
  const color = getOtterColor(state.otterId, otter?.ci)
  const name = otter?.name || 'Otter'

  return (
    <div className="flex gap-2.5 max-w-[780px] mx-auto mb-4 px-6 animate-slideIn">
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0 mt-0.5 shadow-bubble"
        style={{ background: color.gradient }}
      >
        {name.charAt(0)}
      </div>
      <div className="flex flex-col" style={{ maxWidth: '72%' }}>
        <div className="flex items-center gap-1.5 mb-1 px-1">
          <span className={`text-xs font-semibold ${color.nameClass}`}>{name}</span>
          <span className="text-[11px] text-stone-300">正在回复...</span>
        </div>
        <div
          className="msg-content rounded-3xl px-4 py-2.5 text-sm leading-relaxed shadow-bubble bubble-otter bg-white text-stone-700 border border-stone-100"
          style={{ borderLeft: `3px solid ${color.border}` }}
        >
          {/* Live streaming process */}
          <div className="rounded-xl overflow-hidden mb-2" style={{ background: 'rgba(139,111,71,0.04)', border: '1px solid rgba(139,111,71,0.08)' }}>
            <div className="flex items-center gap-1.5 px-3 py-1.5">
              <span className="text-[8px] text-stone-400">▼</span>
              <span className="text-[11px] text-stone-500 font-medium flex-1">流式过程</span>
              <span className="text-[10px] text-stone-400 flex items-center gap-1">
                <span className="flex gap-0.5">
                  <span className="w-1 h-1 rounded-full bg-teal-400 animate-dot" />
                  <span className="w-1 h-1 rounded-full bg-teal-400 animate-dot" style={{ animationDelay: '0.15s' }} />
                  <span className="w-1 h-1 rounded-full bg-teal-400 animate-dot" style={{ animationDelay: '0.3s' }} />
                </span>
                生成中
              </span>
            </div>
            <div className="px-3 py-2 text-[12px] text-stone-500 font-mono whitespace-pre-wrap border-t border-otter-200/20">
              {state.streamingText}
            </div>
          </div>
          {/* Final response (hidden until streaming completes) */}
          {!state.showFinal && (
            <div className="mt-1.5">
              <button
                onClick={onStop}
                className="inline-flex items-center gap-1.5 px-3 py-1 text-xs glass-card text-stone-500 rounded-full transition hover:bg-white/50"
              >
                <Square className="w-2.5 h-2.5 fill-current text-red-400" />
                停止生成
              </button>
            </div>
          )}
          {state.showFinal && (
            <ReactMarkdown>{state.finalText}</ReactMarkdown>
          )}
        </div>
      </div>
    </div>
  )
}
