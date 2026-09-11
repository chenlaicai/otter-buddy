import { useEffect, useRef, useState, useCallback, createContext, useContext, useMemo, isValidElement, type CSSProperties, type ComponentProps, type RefObject } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Element as HastElement } from 'hast'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { AlertTriangle, Square, Copy, Check, Clock, RotateCcw, FileText, Zap, Moon, ArrowRight } from 'lucide-react'
import type { LocalMessage as Message, LocalOtter as Otter, LocalAttachment } from '../../lib/mappers'
import { deriveEntryType, centeredEntryText } from '../../lib/mappers'
import { getOtterColor, OTTER_GRADIENT } from '../../lib/otter-colors'
import { getUserAvatar } from '../../lib/otter-avatars'
import { OtterAvatar } from '../../components/OtterAvatar'
import { fmtTokens, ctxPercent, fmtTime } from '../../lib/utils'
import { fmtBytes } from '../../lib/attachments'
import { parseCardTitle } from '../../lib/html-card'
import { remarkHtmlCardIndex } from '../../lib/remark-html-card-index'
import { HtmlCard } from './HtmlCard'
import { SignalBadge } from './SignalBadge'
import { resolveDisplayName } from './display-name'

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
  onRetryMessage: (messageId: string) => void
  onRetry: () => void
  onGoToSettings: () => void
  otters: Otter[]
  /** 会话 ID（用于 key，切换会话强制 remount） */
  conversationId: string
  isAtBottomRef: RefObject<boolean>
  newMessagesCount?: number
  onJumpToBottom?: () => void
  onLoadMore?: () => void
  loadingMore?: boolean
  onAtBottomChange?: (atBottom: boolean) => void
  unreadSeparatorSeq?: number | null
  highlightMessageId?: string | null
  /** 用户在设置中配置的称呼，用于消息气泡旁的名称显示 */
  userName?: string
  /** 用户滚动到底部时调用，用于标记已读 */
  onReachBottom?: () => void
  /** 信号轨迹（F20260902u5tr）：服务端推导的投石信号投递状态（可选，未加载时不渲染轨迹） */
}

/** 判断是否在底部（阈值 100px） */
function isNearBottom(el: HTMLElement, threshold = 100): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold
}

export function MessageList({
  messages, state, onStopStream, onRetryMessage, onRetry, onGoToSettings, otters,
  conversationId, isAtBottomRef, newMessagesCount = 0, onJumpToBottom, onLoadMore,
  loadingMore, onAtBottomChange,
  unreadSeparatorSeq, highlightMessageId,
  userName, onReachBottom,
}: MessageListProps) {
  /** F20260814qswp：全部 hooks 前置于任何条件 return——旧实现 no-llm/loading/empty 分支
   *  的早退位于 hooks 声明之前，同一挂载实例上 state 切换会导致 hooks 数量变化而崩溃 */
  const scrollRef = useRef<HTMLDivElement>(null)
  /** F20260907sgpt：内容包裹 div 的 ref——ResizeObserver 观测目标。
   * 不可观测滚动容器本身：容器的 contentRect.height 是视口布局高度（flex-1 决定），
   * 内容变化不触发回调（检视发现 1，mimo）；包裹 div 是普通 block，高度随内容真实变化 */
  const contentRef = useRef<HTMLDivElement>(null)
  const prevMessagesLenRef = useRef(messages.length)
  /** 上翻加载历史时，记录需要恢复的滚动位置差值 */
  const pendingScrollRestoreRef = useRef<number | null>(null)
  /** F20260907sgpt：上次采样的内容高度 / 视口高度（两个 observer 各自记各自的） */
  const prevContentHeightRef = useRef(0)
  const prevViewportHeightRef = useRef(0)

  /** 滚动到底部 */
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
  }, [])

  /** 消息数量变化时：如果之前在底部，自动滚到底部；如果有待恢复的滚动位置，恢复它 */
  useEffect(() => {
    const prevLen = prevMessagesLenRef.current
    prevMessagesLenRef.current = messages.length
    // 消息没变，不处理
    if (messages.length === prevLen) return

    // 有待恢复的滚动位置（上翻加载历史后）
    if (pendingScrollRestoreRef.current !== null) {
      const el = scrollRef.current
      if (el) {
        const newScrollHeight = el.scrollHeight
        el.scrollTop = newScrollHeight - pendingScrollRestoreRef.current
      }
      pendingScrollRestoreRef.current = null
      return
    }

    // 消息减少（切换会话），直接滚到底部
    if (messages.length < prevLen) {
      requestAnimationFrame(() => scrollToBottom())
      return
    }
    // 消息增加且在底部，滚到底部
    if (isAtBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom())
    }
  }, [messages.length, scrollToBottom, isAtBottomRef])

  /** F20260907sgpt：高度贴底补偿（双 ResizeObserver，检视发现 1 修正版）。
   *
   * 背景：自 virtuoso→原生滚动迁移（F20260818nscp）起 overflowAnchor:'none'，原生滚动
   * 锚定关闭，且「messages.length effect」只对条数变化补偿——而信号轨迹 chip（trailItems
   * 2s 轮询异步到达）、信号徽标（SSE 终态替换 tmp- 消息，条数不变）等都只在视口内增减
   * 内容高度，条数不变 → 无补偿 → 用户在底部时视口周期性上跳（#790 只修了发言时刻未读
   * 分隔线那一条路）。
   *
   * 修法：两个 observer 分工——
   * - contentObserver 观测内容包裹 div（contentRef）：contentRect.height = 内容总高度，
   *   chip 弹出/徽标出现/流式增长时真实变化。内容高度增大且在底部 → 贴底。
   *   （不可观测滚动容器：容器 contentRect.height 是视口布局高度，内容变化不触发——
   *   首版实现踩过的坑，jsdom 测试手动 fire 回调掩盖了这一点）
   * - viewportObserver 观测滚动容器（scrollRef）：contentRect.height = 视口高度（flex-1
   *   布局）。loadingMore 指示条/窗口缩小会压缩视口，底部内容被推出
   *   视口下缘 → 视口减小且在底部 → 贴底拉回。
   *
   * 边界处理：
   * - 内容高度减小（流式面板折叠等）：scrollHeight 缩短自然把视口推近底部，
   *   isNearBottom 重判，无需补偿；视口增大（banner 消失/窗口拉大）同理不补
   * - requestAnimationFrame 合帧：高频 resize（流式渲染）下每帧至多补偿一次
   * - 上翻加载历史的 preserve-scroll（pendingScrollRestoreRef 路径）互斥：用户上翻中
   *   isAtBottomRef=false，本机制不动作
   * - 依赖 [conversationId]：滚动容器带 key={conversationId}，切会话时容器重建，
   *   mount-only 会观测已卸载元素而失效——切会话时重挂 observer 并重置采样基线 */
  useEffect(() => {
    const content = contentRef.current
    const viewport = scrollRef.current
    if (typeof ResizeObserver === 'undefined' || (!content && !viewport)) return
    prevContentHeightRef.current = 0
    prevViewportHeightRef.current = 0
    const rafPinToBottom = () => {
      requestAnimationFrame(() => {
        const sc = scrollRef.current
        if (sc && isAtBottomRef.current) sc.scrollTop = sc.scrollHeight
      })
    }
    const contentObserver = content ? new ResizeObserver(entries => {
      const entry = entries[entries.length - 1]
      const h = entry?.contentRect?.height ?? 0
      if (h === prevContentHeightRef.current) return // 高度没变（width-only 等）
      const grew = h > prevContentHeightRef.current
      prevContentHeightRef.current = h
      if (!grew) return // 内容缩短：scrollHeight 缩短自然贴底，不补
      if (!isAtBottomRef.current) return // 用户不在底部：任何高度变化都不打扰
      rafPinToBottom()
    }) : null
    const viewportObserver = viewport ? new ResizeObserver(entries => {
      const entry = entries[entries.length - 1]
      const h = entry?.contentRect?.height ?? 0
      if (h === prevViewportHeightRef.current) return
      const shrank = h < prevViewportHeightRef.current
      prevViewportHeightRef.current = h
      if (!shrank) return // 视口增大：底部内容更可见，不补
      if (!isAtBottomRef.current) return
      rafPinToBottom() // 视口被压缩（loadingMore 等）：底部内容被推出视口，拉回
    }) : null
    if (content && contentObserver) contentObserver.observe(content)
    if (viewport && viewportObserver) viewportObserver.observe(viewport)
    return () => { contentObserver?.disconnect(); viewportObserver?.disconnect() }
    // Why: 依赖 conversationId——容器带 key 切会话时重建，需重挂 observer；
    // 其余状态经 ref 读取，无需重订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  /** 滚动事件处理：检测是否在底部 + 触发加载更多 */
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return

    const atBottom = isNearBottom(el)
    isAtBottomRef.current = atBottom
    onAtBottomChange?.(atBottom)

    // 到达底部，标记已读
    if (atBottom && onReachBottom) {
      onReachBottom()
    }

    // 到达顶部，触发加载更多
    if (el.scrollTop === 0 && onLoadMore && !loadingMore) {
      // 记录当前滚动高度，加载后恢复
      pendingScrollRestoreRef.current = el.scrollHeight
      onLoadMore()
    }
  }, [onLoadMore, loadingMore, onAtBottomChange, isAtBottomRef, onReachBottom])

  /** 首次渲染滚到底部 */
  useEffect(() => {
    if (messages.length > 0) {
      requestAnimationFrame(() => {
        scrollToBottom()
        // Why: 首次渲染滚到底部后标记已读（此时 isNearBottom 检测已通过）
        if (onReachBottom) onReachBottom()
      })
    }
    // Why: 有意 mount-only。若补 messages.length 会在用户上翻阅读历史时把每条新消息
    // 都强拉回底部（增量滚动由上方 messages.length effect 按 isAtBottomRef 门控负责）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 切换会话时重置状态 */
  useEffect(() => {
    isAtBottomRef.current = true
    prevMessagesLenRef.current = 0
  }, [conversationId, isAtBottomRef])

  // —— 条件渲染分支（hooks 全部执行完毕后才能 return，见文件内 F20260814qswp 注释）——
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
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {loadingMore && (
        <div className="text-center py-2 text-xs text-stone-400">加载中...</div>
      )}
      <div
        key={conversationId}
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
        style={{ overflowAnchor: 'none' }}
      >
        {/* F20260907sgpt 检视发现 1：内容包裹 div——ResizeObserver 观测目标。
            不可直接观测滚动容器（其 contentRect.height 是视口布局高度，内容变化不触发）。
            普通 block div 高度随内容真实变化；包一层对布局无影响（block 默认占满宽度） */}
        <div ref={contentRef}>
        {/* F20260910ctlv：活动段分组（「新一轮」分隔线）已退役——彻底切换后无轮次概念，
            时间线就是 entries 按序流，invoke 边界由居中条目（⚡/🌙/→）表达 */}
        {messages.map(m => (
          <div key={m.id} data-message-id={m.id}>
            {unreadSeparatorSeq != null && m.seq === unreadSeparatorSeq && (
              <div className="flex items-center gap-2 my-2 mx-auto" style={{ maxWidth: '72%' }}>
                <div className="flex-1 h-px bg-teal-400/40" />
                <span className="text-[10px] text-teal-500 font-medium px-2">未读消息</span>
                <div className="flex-1 h-px bg-teal-400/40" />
              </div>
            )}
            <MessageItem message={m} otters={otters} onStopStream={onStopStream} onRetryMessage={onRetryMessage} highlighted={highlightMessageId === m.id} userName={userName} />
          </div>
        ))}
        </div>
      </div>
      {newMessagesCount > 0 && onJumpToBottom && (
        <button
          onClick={onJumpToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 px-4 py-2 rounded-full shadow-glow text-sm text-white transition hover:scale-105"
          style={{ background: 'linear-gradient(135deg,#A88260,#8B6F47)' }}
        >
          新消息 {newMessagesCount} 条 ↓
        </button>
      )}
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

/** 多模态 Phase 1：消息内附件渲染。图片网格缩略图（点击新窗口看原图）+
 *  document/audio/video 文件卡（点击下载；audio 用原生控件回放，#608）。
 *  同一端点 /api/attachments/:id，image inline / 其他 attachment。
 *  为什么用后端端点而非 base64 内嵌：DTO 只带引用（id/尺寸），消息体积不变，缓存友好（immutable） */
function AttachmentBlock({ atts, isUser }: { atts: LocalAttachment[]; isUser: boolean }) {
  const images = atts.filter(a => a.kind === 'image')
  const audios = atts.filter(a => a.kind === 'audio')
  // document + video 均为文件卡下载样式（检视建议 4：显式命名，未来 video 需特殊渲染时从此处拆出）
  const documentsAndVideos = atts.filter(a => a.kind !== 'image' && a.kind !== 'audio')
  return (
    <div className="mt-2 space-y-2">
      {images.length > 0 && (
        <div className={`grid gap-1.5 ${images.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {images.map(a => (
            <a key={a.id} href={`/api/attachments/${a.id}`} target="_blank" rel="noopener noreferrer" className="block">
              <img
                src={`/api/attachments/${a.id}`}
                alt={a.originalName}
                loading="lazy"
                className={`rounded-xl object-cover cursor-zoom-in hover:opacity-90 transition ${images.length > 1 ? 'w-full aspect-square' : 'max-w-[260px] max-h-[260px]'} ${isUser ? 'border border-white/60' : 'border border-black/5'}`}
              />
            </a>
          ))}
        </div>
      )}
      {audios.length > 0 && (
        <div className="space-y-1.5">
          {audios.map(a => (
            <audio key={a.id} controls preload="none" src={`/api/attachments/${a.id}`} className="w-full max-w-[320px] h-10" />
          ))}
        </div>
      )}
      {documentsAndVideos.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {documentsAndVideos.map(a => (
            <a
              key={a.id}
              href={`/api/attachments/${a.id}`}
              className="inline-flex items-center gap-2 glass-card rounded-xl px-3 py-1.5 text-xs text-stone-600 hover:bg-white/50 transition max-w-full"
              title={a.originalName}
            >
              <FileText className="w-4 h-4 text-stone-400 flex-shrink-0" />
              <span className="truncate">{a.originalName}</span>
              <span className="text-stone-400 flex-shrink-0">{fmtBytes(a.sizeBytes)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

function MessageItem({ message: m, otters, onStopStream, onRetryMessage, highlighted, userName }: { message: Message; otters: Otter[]; onStopStream: (messageId: string) => void; onRetryMessage: (messageId: string) => void; highlighted?: boolean; userName?: string }) {
  // F20260910ctlv：invoke 边界/yield 居中条目（无气泡，图标+文字；与 system 同层但更轻量）
  const entryKind = deriveEntryType(m)
  if (entryKind === 'invoke_start' || entryKind === 'invoke_end' || entryKind === 'yield') {
    const isYield = entryKind === 'yield'
    // yield targets 历史路径是 otterId（mapEntryDTO 原样透出），渲染前映射显示名；
    // 实时路径已由 index.tsx 映射，双重 map 幂等（名字不是 otterId 时原样返回）
    const mappedTargets = m.yieldTargets?.map(t => otters.find(o => o.id === t)?.name || t)
    const text = centeredEntryText(mappedTargets ? { ...m, yieldTargets: mappedTargets } : m)
    return (
      <div className="flex justify-center my-1.5 animate-slideIn">
        <div className="glass-card px-3 py-1 rounded-full flex items-center gap-1.5 text-[11px] text-stone-500 max-w-[80%]">
          {isYield ? (
            <ArrowRight className="w-3 h-3 flex-shrink-0 text-otter-400" />
          ) : entryKind === 'invoke_start' ? (
            <Zap className="w-3 h-3 flex-shrink-0 text-otter-400" />
          ) : (
            <Moon className="w-3 h-3 flex-shrink-0 text-stone-400" />
          )}
          <span className="truncate" title={text}>{text}</span>
          <span className="msg-meta text-[10px] flex-shrink-0">{fmtTime(m.ts)}</span>
        </div>
      </div>
    )
  }

  // System 消息：居中显示，特殊样式，支持 markdown 渲染
  if (m.st === 'system') {
    return (
      <div className="flex justify-center my-3 animate-slideIn">
        <div className="glass-card px-4 py-2 text-xs text-stone-500 max-w-[600px]">
          <div className="flex items-center gap-2 mb-1">
            <Clock size={14} className="text-stone-400 flex-shrink-0" />
            <span className="msg-meta text-[11px]">系统消息 · {fmtTime(m.ts)}</span>
          </div>
          <div className="leading-relaxed system-msg-body [&_strong]:font-semibold [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5">
            <MarkdownContent variant="otter-body">{m.content}</MarkdownContent>
          </div>
        </div>
      </div>
    )
  }

  const isUser = m.st === 'user'
  const inFlight = m.status === 'streaming' || m.status === 'speaking'
  const userDisplayName = userName?.trim() || '我'
  // F20260826fuid：user 消息优先用快照名（飞书群聊多人识别），无快照回退全局名（单聊不变）
  // F20260826fpbd：远程消息（飞书等）无快照时显示中性标签，不回退全局名——避免快照缺失时把访客冒充成搭档
  const snapshotName = isUser ? (m.sn || '').trim() : ''
  const remoteFallbackName = m.src === 'feishu' ? '飞书成员' : m.src ? '外部成员' : ''
  const name = isUser ? (snapshotName || remoteFallbackName || userDisplayName) : resolveDisplayName(m, otters)
  const color = isUser ? null : getOtterColor(m.si)
  const nameColor = isUser ? 'text-stone-600' : color?.nameClass || 'text-otter-500'
  const sideBar: CSSProperties = !isUser
    ? { borderLeft: `3px solid ${color?.border || '#8B6F47'}`, '--otter-tint': color?.border || '#8B6F47' } as CSSProperties
    /* 用户身份色用中性石灰系，避免与 o1 品牌棕撞色 */
    : { borderRight: '3px solid #6B6157', '--otter-tint': '#8B7E72' } as CSSProperties
  const dur = m.dur ? ` · ${m.dur}` : ''

  return (
    <div className={`flex gap-2.5 mx-auto mb-4 px-1 animate-slideIn ${isUser ? 'flex-row-reverse' : ''}`}>
      {isUser ? (
        <img
          src={getUserAvatar()}
          alt={name}
          className="w-8 h-8 rounded-full flex-shrink-0 mt-0.5 msg-avatar shadow-bubble object-cover"
          style={{ border: '2px solid #6B6157' }}
        />
      ) : (
        <div className="mt-0.5">
          <OtterAvatar otterId={m.si} name={name} type={otters.find(o => o.id === m.si)?.type} />
        </div>
      )}
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
          } ${!isUser && inFlight ? 'bubble-live' : ''} ${highlighted ? 'highlight-message' : ''}`}
          style={sideBar}
        >
          {/* F20260910ctlv 切换清扫：StreamingProcess 气泡内流式折叠区已退役——
              流式过程不再嵌在消息气泡，统一在 Session 弹窗（点獭头像）展示。
              后端已停发流式 SSE（1970b43b），历史 messages.events 不再渲染。 */}
          {/* F20260826mwrd C4: 獭间信号徽章（消息原位渲染，<signal> 块剥离后的视觉表达） */}
          {!isUser && m.signals && m.signals.length > 0 && (
            <div className="mb-1.5">
              {m.signals.map(sig => (
                <SignalBadge key={sig.id} signal={sig} fromName={otters.find(o => o.id === sig.fromOtterId)?.name} />
              ))}
            </div>
          )}
          {/* F-multi-speak-bubble: 分段渲染 */}
          {m.segments && m.segments.length > 0 ? (
            <div className="space-y-2">
              {m.segments
                .slice()
                .sort((a, b) => a.sequenceNum - b.sequenceNum)
                .map((seg, idx) => (
                  <div
                    key={seg.id}
                    className="relative group"
                    style={idx > 0 ? { borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: '0.5rem' } : undefined}
                  >
                    <MarkdownContent variant={isUser ? 'user-body' : 'otter-body'} messageId={m.id} authorId={m.si}>{seg.body}</MarkdownContent>
                    <div className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition">
                      <CopyButton text={seg.body} />
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <div className="relative group">
              {m.content
                ? <MarkdownContent variant={isUser ? 'user-body' : 'otter-body'} messageId={m.id} authorId={m.si}>{m.content}</MarkdownContent>
                : <span className="text-stone-400">{inFlight ? '正在回复...' : ''}</span>
              }
              <div className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition">
                <CopyButton text={m.content} />
              </div>
            </div>
          )}
          {/* 多模态 Phase 1：附件块（图片网格 + 文件卡），正文后渲染 */}
          {m.atts && m.atts.length > 0 && <AttachmentBlock atts={m.atts} isUser={isUser} />}
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
          {(m.status === 'failed' || m.status === 'aborted') && !isUser && (
            <div className="mt-1.5">
              <button
                onClick={() => onRetryMessage(m.id)}
                className="inline-flex items-center gap-1.5 px-3 py-1 text-xs glass-card text-stone-500 rounded-full transition hover:bg-white/50"
              >
                <RotateCcw className="w-2.5 h-2.5" />
                重试
              </button>
            </div>
          )}
        </div>
        {/* F20260910ctlv 收尾：user 气泡传递行在气泡外（下方一行小字）——气泡内只放说话内容。
             yieldTargets = 发言石目标（实时路径 SSE entry.user 携带 / 历史路径 EntryDTO 透出，
             otterId 在此映射显示名） */}
        {isUser && m.yieldTargets && m.yieldTargets.length > 0 && (
          <div className="mt-0.5 flex justify-end items-center gap-1 text-[10px] msg-meta pr-1">
            <ArrowRight className="w-2.5 h-2.5 text-stone-300 flex-shrink-0" />
            <span>{m.yieldTargets.map(t => otters.find(o => o.id === t)?.name || t).join('、')}</span>
          </div>
        )}
      </div>
    </div>
  )
}

