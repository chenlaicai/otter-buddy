import { useRef, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { AlertTriangle, Square, Copy, Check, Clock } from 'lucide-react'
import type { LocalMessage as Message, LocalOtter as Otter, LocalMessageEvent } from '../../lib/mappers'
import { getOtterColor, OTTER_GRADIENT } from '../../lib/otter-colors'
import { fmtTokens, ctxPercent } from '../../lib/utils'

/** 复制按钮 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard API 不可用时静默忽略 */ }
  }
  return (
    <button
      onClick={handleCopy}
      className="p-1 rounded hover:bg-stone-200 transition text-stone-400 hover:text-stone-600"
      title="复制"
    >
      {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
    </button>
  )
}

/** Markdown 渲染组件（GFM + 代码高亮） */
function MarkdownContent({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '')
          const text = String(children).replace(/\n$/, '')
          if (match) {
            return <SyntaxHighlighter style={oneLight} language={match[1]} PreTag="div" customStyle={{ margin: '8px 0', borderRadius: 8, fontSize: 13 }}>{text}</SyntaxHighlighter>
          }
          return <code className={className} {...props}>{children}</code>
        },
      }}
    >
      {children}
    </ReactMarkdown>
  )
}

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
  duration: number
  events: LocalMessageEvent[]
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
  // System 消息：居中显示，特殊样式
  if (m.st === 'system') {
    return (
      <div className="flex justify-center my-3 animate-slideIn">
        <div className="glass-card px-4 py-2 text-xs text-stone-500 flex items-center gap-2 max-w-[500px]">
          <Clock size={14} className="text-stone-400 flex-shrink-0" />
          <span className="flex-1">{m.content}</span>
          <span className="text-stone-300 text-[11px] flex-shrink-0">{m.ts}</span>
        </div>
      </div>
    )
  }

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
          <div className="relative group">
            <MarkdownContent>{m.content}</MarkdownContent>
            <div className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition">
              <CopyButton text={m.content} />
            </div>
          </div>
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
  const [expanded, setExpanded] = useState(false)

  /** assistant_toolcall：展示 event_type + 工具名 + 参数 */
  if (eventType === 'assistant_toolcall') {
    const content = payload.content as Array<Record<string, unknown>> | undefined
    const toolCall = content?.find(c => c.type === 'toolCall') as Record<string, unknown> | undefined
    const toolName = (toolCall?.name as string) || ''
    const params = toolCall?.arguments
    const paramsStr = params ? JSON.stringify(params) : ''
    const paramsPreview = paramsStr.length > 60 ? paramsStr.slice(0, 60) + '...' : paramsStr

    return (
      <div className="border-b border-stone-100 last:border-0">
        <div
          className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-white/40 transition"
          onClick={() => setExpanded(!expanded)}
        >
          <span className={`text-[8px] text-stone-400 transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
          <span className="text-[9px] px-1.5 py-0.5 rounded font-mono font-medium bg-amber-50 text-amber-700">{eventType}</span>
          <span className="text-[11px] text-stone-600 truncate flex-1">{toolName} {paramsPreview}</span>
          <CopyButton text={paramsStr} />
        </div>
        {expanded && paramsStr && (
          <div className="px-3 pb-2 pl-8">
            <div className="text-[11px] text-stone-500 bg-stone-50 rounded-lg px-3 py-2 max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all">
              {paramsStr}
            </div>
          </div>
        )}
      </div>
    )
  }

  /** tool_result：展示 event_type + 工具名 + 结果预览 */
  if (eventType === 'tool_result') {
    const name = payload.name as string
    const result = payload.result as Record<string, unknown> | undefined
    const resultContent = result?.content as Array<{ text?: string }> | undefined
    const resultText = resultContent?.[0]?.text || (result ? JSON.stringify(result) : '')
    const resultPreview = resultText.length > 80 ? resultText.slice(0, 80) + '...' : resultText

    return (
      <div className="border-b border-stone-100 last:border-0">
        <div
          className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-white/40 transition"
          onClick={() => setExpanded(!expanded)}
        >
          <span className={`text-[8px] text-stone-400 transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
          <span className="text-[9px] px-1.5 py-0.5 rounded font-mono font-medium bg-teal-100 text-teal-700">{eventType}</span>
          <span className="text-[11px] text-stone-600 truncate flex-1">{name} {resultPreview}</span>
          <CopyButton text={resultText} />
        </div>
        {expanded && resultText && (
          <div className="px-3 pb-2 pl-8">
            <div className="text-[11px] text-stone-500 bg-stone-50 rounded-lg px-3 py-2 max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all">
              {resultText}
            </div>
          </div>
        )}
      </div>
    )
  }

  /** assistant_text：展示 event_type + 文本预览 */
  if (eventType === 'assistant_text') {
    const content = payload.content as Array<Record<string, unknown>> | undefined
    const text = content?.find(c => c.type === 'text')
    const str = (text?.text as string) || ''
    const preview = str.length > 100 ? str.slice(0, 100) + '...' : str

    return (
      <div className="border-b border-stone-100 last:border-0">
        <div
          className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-white/40 transition"
          onClick={() => setExpanded(!expanded)}
        >
          <span className={`text-[8px] text-stone-400 transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
          <span className="text-[9px] px-1.5 py-0.5 rounded font-mono font-medium bg-blue-50 text-blue-700">{eventType}</span>
          <span className="text-[11px] text-stone-600 truncate flex-1">{preview}</span>
          <CopyButton text={str} />
        </div>
        {expanded && str && (
          <div className="px-3 pb-2 pl-8">
            <div className="text-[11px] text-stone-500 bg-stone-50 rounded-lg px-3 py-2 max-h-[400px] overflow-y-auto prose prose-xs max-w-none">
              <MarkdownContent>{str}</MarkdownContent>
            </div>
          </div>
        )}
      </div>
    )
  }

  /** error */
  if (eventType === 'error') {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-stone-100 last:border-0">
        <span className="text-[9px] px-1.5 py-0.5 rounded font-mono font-medium bg-red-50 text-red-700">{eventType}</span>
        <span className="text-[11px] text-red-600">{payload.message as string}</span>
        <CopyButton text={payload.message as string} />
      </div>
    )
  }

  return null
}

function StreamingMessage({ state, onStop, otters }: { state: StreamingState; onStop: () => void; otters: Otter[] }) {
  const otter = otters.find(o => o.id === state.otterId)
  const color = getOtterColor(state.otterId, otter?.ci)
  const name = otter?.name || 'Otter'
  const events = state.events || []

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
          {/* 实时流式过程 */}
          {events.length > 0 && (
            <div className="rounded-xl overflow-hidden mb-2" style={{ background: 'rgba(139,111,71,0.04)', border: '1px solid rgba(139,111,71,0.08)' }}>
              <div className="flex items-center gap-1.5 px-3 py-1.5">
                <span className="text-[8px] text-stone-400">▼</span>
                <span className="text-[11px] text-stone-500 font-medium flex-1">流式过程 · {events.length} 个事件</span>
                <span className="text-[10px] text-stone-400 flex items-center gap-1">
                  <span className="flex gap-0.5">
                    <span className="w-1 h-1 rounded-full bg-teal-400 animate-dot" />
                    <span className="w-1 h-1 rounded-full bg-teal-400 animate-dot" style={{ animationDelay: '0.15s' }} />
                    <span className="w-1 h-1 rounded-full bg-teal-400 animate-dot" style={{ animationDelay: '0.3s' }} />
                  </span>
                  生成中
                </span>
              </div>
              <div className="border-t border-otter-200/20">
                {events.map((evt, i) => <EventItem key={i} event={evt} />)}
              </div>
            </div>
          )}
          {/* 停止按钮 */}
          <div className="mt-1.5">
            <button
              onClick={onStop}
              className="inline-flex items-center gap-1.5 px-3 py-1 text-xs glass-card text-stone-500 rounded-full transition hover:bg-white/50"
            >
              <Square className="w-2.5 h-2.5 fill-current text-red-400" />
              停止生成
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
