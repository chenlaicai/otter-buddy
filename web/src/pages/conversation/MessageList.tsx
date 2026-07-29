import { useRef, useEffect, useState, createContext, useContext, useMemo, isValidElement, type CSSProperties, type ComponentProps } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Element as HastElement } from 'hast'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { AlertTriangle, Square, Copy, Check, Clock } from 'lucide-react'
import type { LocalMessage as Message, LocalOtter as Otter, LocalMessageEvent } from '../../lib/mappers'
import { getOtterColor, OTTER_GRADIENT } from '../../lib/otter-colors'
import { fmtTokens, ctxPercent, fmtTime } from '../../lib/utils'
import { parseCardTitle } from '../../lib/html-card'
import { remarkHtmlCardIndex } from '../../lib/remark-html-card-index'
import { HtmlCard } from './HtmlCard'

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

/** Markdown 渲染变体：otter-body 可交互卡片 / user-body 静态卡片 / event-log 一律源码块 */
type MarkdownVariant = 'otter-body' | 'user-body' | 'event-log'

/** 卡片渲染上下文（消息级）：components 映射必须是模块级稳定引用，消息上下文经 context 传递 */
interface CardRenderCtx {
  variant: MarkdownVariant
  messageId: string
  authorId: string
}
const CardRenderContext = createContext<CardRenderCtx>({ variant: 'otter-body', messageId: '', authorId: '' })

type CodeComponentProps = ComponentProps<'code'> & { node?: HastElement }

/** 语法高亮源码块（与既有代码块样式一致） */
function highlightSource(language: string, text: string) {
  return <SyntaxHighlighter style={oneLight} language={language} PreTag="div" customStyle={{ margin: '8px 0', borderRadius: 8, fontSize: 13 }}>{text}</SyntaxHighlighter>
}

/** html-card-reply 围栏：折叠"表单数据"标签（点击展开查看 JSON 原文） */
function CardReplyLabel({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="block my-1">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] bg-teal-400/15 text-teal-600 hover:bg-teal-400/25 transition"
      >
        表单数据 {open ? '▾' : '▸'}
      </button>
      {open && (
        <pre className="mt-1 text-[11px] text-stone-500 bg-stone-50 rounded-lg px-3 py-2 whitespace-pre-wrap break-all">{text}</pre>
      )}
    </span>
  )
}

/** code 组件：先精确匹配 html-card 围栏（\w 不含连字符，落到通用正则会误判成 HTML 高亮），再走既有逻辑 */
function CardAwareCode({ className, children, node, ...props }: CodeComponentProps) {
  const ctx = useContext(CardRenderContext)
  const text = String(children).replace(/\n$/, '')

  if (className === 'language-html-card') {
    // 事件流文本的 fenceIndex 与 message.body 不对应，一律源码块（不进 registry）
    if (ctx.variant === 'event-log') return highlightSource('html', text)
    // fenceIndex 经 remark 插件 hProperties 通道写入（mdast→hast 不透传任意 data key）。
    // fail-closed：注解缺失时不能猜 0（会张冠李戴到首张卡），降级为源码块
    const rawFenceIndex = node?.properties?.dataFenceIndex
    if (rawFenceIndex == null) return highlightSource('html', text)
    const fenceIndex = Number(rawFenceIndex)
    // react-markdown 9.1：meta 在 hast data 上，不在 node.meta
    const meta = (node?.data as { meta?: string } | undefined)?.meta
    const cardId = `${ctx.messageId}:${fenceIndex}`
    return (
      <HtmlCard
        key={cardId}
        cardId={cardId}
        fenceIndex={fenceIndex}
        title={parseCardTitle(meta)}
        code={text}
        interactive={ctx.variant === 'otter-body'}
        authorId={ctx.authorId}
      />
    )
  }
  if (className === 'language-html-card-reply') {
    if (ctx.variant === 'event-log') return highlightSource('json', text)
    return <CardReplyLabel text={text} />
  }

  const match = /language-(\w+)/.exec(className || '')
  if (match) return highlightSource(match[1], text)
  return <code className={className} {...props}>{children}</code>
}

/** pre 组件：卡片/回执标签不被 pre 包裹（避免继承等宽字体与 overflow 样式），其余保持默认。
 *  pre 的 children 是 code 组件的 JSX element（尚未渲染成卡片），按 className 检测 */
function CardAwarePre({ children, node, ...props }: ComponentProps<'pre'> & { node?: unknown }) {
  void node
  if (isValidElement(children)) {
    const cls = (children.props as { className?: string }).className
    if (cls === 'language-html-card' || cls === 'language-html-card-reply') return <>{children}</>
  }
  return <pre {...props}>{children}</pre>
}

function PreWrapP({ children, node, ...props }: ComponentProps<'p'> & { node?: unknown }) {
  void node
  return <p style={{ whiteSpace: 'pre-wrap' }} {...props}>{children}</p>
}

/** 三变体各持一份模块级 components 映射（内联定义每次渲染新建引用 → react-markdown 以引用为
 *  element type → 流式期间已展开卡片反复重挂载、表单状态丢失；模块级常量引用稳定且变体间隔离） */
const otterBodyComponents: Components = { code: CardAwareCode, pre: CardAwarePre, p: PreWrapP }
const userBodyComponents: Components = { code: CardAwareCode, pre: CardAwarePre, p: PreWrapP }
const eventLogComponents: Components = { code: CardAwareCode, pre: CardAwarePre, p: PreWrapP }

const REMARK_PLUGINS: NonNullable<ComponentProps<typeof ReactMarkdown>['remarkPlugins']> = [
  [remarkGfm, { singleTilde: false }],
  remarkHtmlCardIndex,
]

/** Markdown 渲染组件（GFM + 代码高亮 + HTML 卡片路由） */
function MarkdownContent({ children, variant = 'otter-body', messageId = '', authorId = '' }: {
  children: string
  variant?: MarkdownVariant
  messageId?: string
  authorId?: string
}) {
  const ctx = useMemo<CardRenderCtx>(() => ({ variant, messageId, authorId }), [variant, messageId, authorId])
  const components = variant === 'otter-body' ? otterBodyComponents : variant === 'user-body' ? userBodyComponents : eventLogComponents
  return (
    <CardRenderContext.Provider value={ctx}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {children}
      </ReactMarkdown>
    </CardRenderContext.Provider>
  )
}

interface MessageListProps {
  messages: Message[]
  state: 'normal' | 'empty' | 'loading' | 'error' | 'no-llm'
  onStopStream: (messageId: string) => void
  onRetry: () => void
  onGoToSettings: () => void
  otters: Otter[]
}

export function MessageList({ messages, state, onStopStream, onRetry, onGoToSettings, otters }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

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
      <div className="mx-auto px-1">
        <div className="h-14 mb-2 rounded-3xl bg-white/30 animate-pulse" />
        <div className="h-14 mb-2 rounded-3xl bg-white/30 animate-pulse" />
        <div className="h-14 rounded-3xl bg-white/30 animate-pulse" />
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-stone-300 gap-2">
        <div className="text-sm font-medium text-stone-400">开始对话</div>
        <div className="text-xs text-stone-400">在下方输入消息开始与大獭对话</div>
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="msg-scroll flex-1 overflow-y-auto py-4">
      {messages.map((m, i) => {
        const prevTurnId = i > 0 ? messages[i - 1].turnId : undefined
        const isNewTurn = m.turnId && m.turnId !== prevTurnId
        return (
          <div key={m.id} className={isNewTurn ? 'mt-3 pt-3 border-t border-stone-200/50' : ''}>
            <MessageItem message={m} otters={otters} onStopStream={onStopStream} />
          </div>
        )
      })}
      {state === 'error' && (
        <div className="mx-auto px-1 my-2">
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

function MessageItem({ message: m, otters, onStopStream }: { message: Message; otters: Otter[]; onStopStream: (messageId: string) => void }) {
  // System 消息：居中显示，特殊样式
  if (m.st === 'system') {
    return (
      <div className="flex justify-center my-3 animate-slideIn">
        <div className="glass-card px-4 py-2 text-xs text-stone-500 flex items-center gap-2 max-w-[500px]">
          <Clock size={14} className="text-stone-400 flex-shrink-0" />
          <span className="flex-1">{m.content}</span>
          <span className="msg-meta text-[11px] flex-shrink-0">{fmtTime(m.ts)}</span>
        </div>
      </div>
    )
  }

  const isUser = m.st === 'user'
  const inFlight = m.status === 'streaming' || m.status === 'speaking'
  const otter = isUser ? null : otters.find(o => o.id === m.si)
  const name = isUser ? '我' : (m.sn || otter?.name || 'Otter')
  const color = isUser ? null : getOtterColor(m.si)
  const bgGrad = isUser ? 'linear-gradient(135deg,#8B7E72,#6B6157)' : color?.gradient
  const nameColor = isUser ? 'text-stone-600' : color?.nameClass || 'text-otter-500'
  const sideBar: CSSProperties = !isUser
    ? { borderLeft: `3px solid ${color?.border || '#8B6F47'}`, '--otter-tint': color?.border || '#8B6F47' } as CSSProperties
    /* 用户身份色用中性石灰系，避免与 o1 品牌棕撞色 */
    : { borderRight: '3px solid #6B6157', '--otter-tint': '#8B7E72' } as CSSProperties
  const dur = m.dur ? ` · ${m.dur}` : ''

  return (
    <div className={`flex gap-2.5 mx-auto mb-4 px-1 animate-slideIn ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0 mt-0.5 msg-avatar"
        style={{ background: bgGrad }}
      >
        {isUser ? '我' : name.charAt(0)}
      </div>
      <div className={`flex flex-col ${isUser ? 'items-end' : ''}`} style={{ maxWidth: '72%' }}>
        <div className="flex items-center gap-1.5 mb-1 px-1">
          <span className={`text-xs font-semibold ${nameColor}`}>{name}</span>
          {m.src === 'feishu' && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-blue-50 text-blue-600 font-medium">
              飞书
            </span>
          )}
          <span className="text-[11px] msg-meta">{inFlight ? `${fmtTime(m.ts)} · 正在回复...` : `${fmtTime(m.ts)}${dur}`}</span>
          {/* token 条在主流程位置（#88），但 ctx 缺失（进行中/历史未持久化）时不渲染（M3） */}
          {!isUser && m.ctx != null && (
            <span className="flex items-center gap-1.5 text-[10px] msg-meta ml-1">
              <span>{fmtTokens(m.ctx)} / {fmtTokens(m.ctxMax || 200000)}</span>
              <span className="w-16 h-0.5 rounded-full" style={{ background: 'rgba(139,111,71,0.1)' }}>
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${ctxPercent(m.ctx, m.ctxMax || 200000)}%`, background: '#8B6F47' }}
                />
              </span>
            </span>
          )}
        </div>
        <div
          className={`msg-content rounded-3xl px-4 py-2.5 text-sm leading-relaxed text-stone-700 ${
            isUser ? 'bubble-user' : 'bubble-otter'
          } ${!isUser && inFlight ? 'bubble-live' : ''}`}
          style={sideBar}
        >
          {!isUser && m.events && m.events.length > 0 && <StreamingProcess key={inFlight ? 'live' : 'done'} events={m.events} duration={m.dur || ''} status={m.status} />}
          <div className="relative group">
            {m.content
              ? <MarkdownContent variant={isUser ? 'user-body' : 'otter-body'} messageId={m.id} authorId={m.si}>{m.content}</MarkdownContent>
              : <span className="text-stone-400">{inFlight ? '正在回复...' : ''}</span>
            }
            <div className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition">
              <CopyButton text={m.content} />
            </div>
          </div>
          {/* 进行中的消息（实时或刷新后重新进入）保留停止能力 */}
          {inFlight && (
            <div className="mt-1.5">
              <button
                onClick={() => onStopStream(m.id)}
                className="inline-flex items-center gap-1.5 px-3 py-1 text-xs glass-card text-stone-500 rounded-full transition hover:bg-white/50"
              >
                <Square className="w-2.5 h-2.5 fill-current text-red-400" />
                停止生成
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StreamingProcess({ events, duration, status }: { events: LocalMessageEvent[]; duration: string; status?: Message['status'] }) {
  const inFlight = status === 'streaming' || status === 'speaking'
  /** 进行中的流式过程默认展开（实时可见），终态默认折叠 */
  const [collapsed, setCollapsed] = useState(!inFlight)
  /** 流式进行中：实时计时 */
  const [elapsed, setElapsed] = useState<string | null>(null)
  useEffect(() => {
    if (!inFlight || events.length === 0) { setElapsed(null); return }
    const startTs = new Date(events[0].ts).getTime()
    const tick = () => setElapsed(`${((Date.now() - startTs) / 1000).toFixed(1)}s`)
    tick()
    const timer = setInterval(tick, 100)
    return () => clearInterval(timer)
  }, [inFlight, events[0]?.ts])
  const statusLabel = inFlight
    ? `进行中 · ${elapsed || '...'}`
    : status === 'failed'
      ? '失败'
      : status === 'aborted'
        ? '已中断'
        : `已完成${duration ? ` · ${duration}` : ''}`

  return (
    <div className={`streaming-section mb-2 rounded-xl overflow-hidden ${inFlight ? 'stream-shimmer' : ''}`} style={{ background: 'var(--surface-inset)', border: '1px solid var(--inset-border)' }}>
      <div
        className="flex items-center gap-1.5 px-3 py-1.5 cursor-pointer hover:bg-white/30 transition"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className={`streaming-icon text-[8px] text-stone-400 transition ${collapsed ? '' : 'rotate-180'}`}>▼</span>
        <span className="text-[11px] text-stone-500 font-medium flex-1">流式过程 · {events.length} 个事件</span>
        <span className="text-[10px] text-stone-400 flex items-center gap-1">
          {inFlight && (
            <span className="flex gap-0.5">
              <span className="w-1 h-1 rounded-full bg-teal-400 animate-dot" />
              <span className="w-1 h-1 rounded-full bg-teal-400 animate-dot" style={{ animationDelay: '0.15s' }} />
              <span className="w-1 h-1 rounded-full bg-teal-400 animate-dot" style={{ animationDelay: '0.3s' }} />
            </span>
          )}
          {statusLabel}
        </span>
      </div>
      {!collapsed && (
        <div className="streaming-body border-t border-otter-200/20 max-h-[400px] overflow-y-auto">
          {events.map((evt, i) => <EventItem key={i} event={evt} prevTs={i > 0 ? events[i - 1].ts : undefined} />)}
        </div>
      )}
    </div>
  )
}

function EventItem({ event, prevTs }: { event: LocalMessageEvent; prevTs?: string }) {
  const { eventType, payload } = event
  const [expanded, setExpanded] = useState(false)
  const elapsed = prevTs ? `+${((new Date(event.ts).getTime() - new Date(prevTs).getTime()) / 1000).toFixed(1)}s` : null

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
          {elapsed && <span className="text-[10px] text-stone-400 flex-shrink-0">{elapsed}</span>}
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
          {elapsed && <span className="text-[10px] text-stone-400 flex-shrink-0">{elapsed}</span>}
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
          {elapsed && <span className="text-[10px] text-stone-400 flex-shrink-0">{elapsed}</span>}
          <CopyButton text={str} />
        </div>
        {expanded && str && (
          <div className="px-3 pb-2 pl-8">
            <div className="text-[11px] text-stone-500 bg-stone-50 rounded-lg px-3 py-2 max-h-[400px] overflow-y-auto prose prose-xs max-w-none">
              <MarkdownContent variant="event-log">{str}</MarkdownContent>
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
        {elapsed && <span className="text-[10px] text-stone-400 flex-shrink-0">{elapsed}</span>}
        <CopyButton text={payload.message as string} />
      </div>
    )
  }

  return null
}
