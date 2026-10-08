import { useEffect, useRef, useState, useCallback, createContext, useContext, useMemo, isValidElement, type CSSProperties, type ComponentProps, type RefObject } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Element as HastElement } from 'hast'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { AlertTriangle, Square, Copy, Check, Clock, RotateCcw, FileText, Zap, Moon, ArrowRight, X } from 'lucide-react'
import type { LocalMessage as Message, LocalOtter as Otter, LocalAttachment } from '../../lib/mappers'
import { deriveEntryType, centeredEntryText } from '../../lib/mappers'
import { OTTER_GRADIENT } from '../../lib/otter-colors'
import { resolveOtterVisual } from '../../lib/otter-visual'
import { getUserAvatar } from '../../lib/otter-avatars'
import { OtterAvatar } from '../../components/OtterAvatar'
import { fmtTokens, ctxPercent, fmtTime } from '../../lib/utils'
import { fmtBytes } from '../../lib/attachments'
import { parseCardTitle } from '../../lib/html-card'
import { remarkHtmlCardIndex } from '../../lib/remark-html-card-index'
import { remarkBareLink } from '../../lib/remark-bare-link'
import { HtmlCard } from './HtmlCard'
import { SignalBadge } from './SignalBadge'
import { UnfurlCard } from './UnfurlCard'
import { ArtifactCard } from './ArtifactCard'
import type { LocalLinkedResource } from '../../lib/mappers'
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
  /** F20260916hcel：html-card schema版本（保留字段，供未来默认状态变化用；当前所有卡默认折叠） */
  cardSchemaVersion?: number
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
        cardSchemaVersion={ctx.cardSchemaVersion}
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

/** F20261008csf1 P1：a 组件——裸链段落升级为 unfurl 预览卡（链类形态）。
 *  判定不在组件层做：react-markdown 传给 components 的 hast 节点无 .parent 指针
 *  （unist 树不回填父指针），拿不到段落上下文——改由 remark 插件（remark-bare-link）
 *  在 mdast 层判定，经 hProperties 通道写入 dataBareUrl（与 html-card fenceIndex 同构），
 *  组件从 node.properties 读。fail-closed：标记缺失时维持行内链接 */
function UnfurlAwareLink({ href, children, node, ...props }: ComponentProps<'a'> & { node?: unknown }) {
  void children
  const bareUrl = (node as { properties?: { dataBareUrl?: string } } | undefined)?.properties?.dataBareUrl
  if (href && bareUrl && bareUrl === href) {
    return <UnfurlCard url={href} />
  }
  return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
}

function PreWrapP({ children, node, ...props }: ComponentProps<'p'> & { node?: unknown }) {
  void node
  return <p style={{ whiteSpace: 'pre-wrap' }} {...props}>{children}</p>
}

/** 三变体各持一份模块级 components 映射（内联定义每次渲染新建引用 → react-markdown 以引用为
 *  element type → 流式期间已展开卡片反复重挂载、表单状态丢失；模块级常量引用稳定且变体间隔离） */
const otterBodyComponents: Components = { code: CardAwareCode, pre: CardAwarePre, p: PreWrapP, a: UnfurlAwareLink }
const userBodyComponents: Components = { code: CardAwareCode, pre: CardAwarePre, p: PreWrapP, a: UnfurlAwareLink }
const eventLogComponents: Components = { code: CardAwareCode, pre: CardAwarePre, p: PreWrapP }

const REMARK_PLUGINS: NonNullable<ComponentProps<typeof ReactMarkdown>['remarkPlugins']> = [
  [remarkGfm, { singleTilde: false }],
  remarkHtmlCardIndex,
  remarkBareLink,
]

/** Markdown 渲染组件（GFM + 代码高亮 + HTML 卡片路由） */
function MarkdownContent({ children, variant = 'otter-body', messageId = '', authorId = '', cardSchemaVersion }: {
  children: string
  variant?: MarkdownVariant
  messageId?: string
  authorId?: string
  /** F20260916hcel：html-card schema版本（保留字段，供未来默认状态变化用；当前所有卡默认折叠） */
  cardSchemaVersion?: number
}) {
  const ctx = useMemo<CardRenderCtx>(() => ({ variant, messageId, authorId, cardSchemaVersion }), [variant, messageId, authorId, cardSchemaVersion])
  const components = variant === 'otter-body' ? otterBodyComponents : variant === 'user-body' ? userBodyComponents : eventLogComponents
  return (
    <CardRenderContext.Provider value={ctx}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {children}
      </ReactMarkdown>
    </CardRenderContext.Provider>
  )
}



/** F20261008scpg scroll-pin 状态机常量：账本过期时长 / 归因匹配容差 / touch 脱锚位移阈值 */
const LEDGER_TTL_MS = 1000
const LEDGER_EPS_PX = 4
const TOUCH_UNPIN_PX = 10
/** 程序写入语义标签：pin=贴底补偿/跳底按钮/mount 起始贴底；restore=上翻加载恢复（init 已并入 pin——
 *  mount 贴底本就是 pin 语义，且账本 expected=scrollHeight 不会是 0，避免小值陈旧条目误吞位移归因） */
type ScrollWriteTag = 'pin' | 'restore'
interface ScrollLedgerEntry { expected: number; tag: ScrollWriteTag; interrupted: boolean; ts: number }

/** F20261008csf1 P1：混排时间线条目——消息气泡 or 文类产物摘要卡 */
type TimelineItem =
  | { kind: 'message'; ts: string; seq: number; message: Message }
  | { kind: 'artifact'; ts: string; seq: -1; resource: LocalLinkedResource }

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
  /** F20261008scpg：是否贴底跟随的单一事实源（true=pinned）。语义从旧 isAtBottomRef 的
   *  几何快照升级为意图驱动状态机——共享 ref 透传形状不变（index 新消息计数/发言回底直读写） */
  pinRef: RefObject<boolean>
  newMessagesCount?: number
  /** 跳底按钮回调：滚动与置 pin 在本组件内完成，回调只承担计数清零等业务侧处理 */
  onJumpToBottom?: () => void
  onLoadMore?: () => void
  loadingMore?: boolean
  unreadSeparatorSeq?: number | null
  highlightMessageId?: string | null
  /** 用户在设置中配置的称呼，用于消息气泡旁的名称显示 */
  userName?: string
  /** F20261008csf1 P1：文类产物摘要卡数据源（linked_resources，pr/file/fact 类型混排进时间轴） */
  linkedResources?: LocalLinkedResource[]
  /** 信号轨迹（F20260902u5tr）：服务端推导的投石信号投递状态（可选，未加载时不渲染轨迹） */
}

/** 判断是否在底部（阈值 100px） */
function isNearBottom(el: HTMLElement, threshold = 100): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold
}

export function MessageList({
  messages, state, onStopStream, onRetryMessage, onRetry, onGoToSettings, otters,
  conversationId, pinRef, newMessagesCount = 0, onJumpToBottom, onLoadMore,
  loadingMore,
  unreadSeparatorSeq, highlightMessageId,
  userName, linkedResources,
}: MessageListProps) {
  /** F20261008csf1 P1：产物卡「钉住」逃生口——前端 UI 状态不落持久化（宪法 P1 允许，
   *  取舍见特性文档）：钉住的卡在「贴时间轴插入」的同时保持在视口底部附近可及——
   *  实现取最简语义：钉住的卡渲染两份会违反时间轴纯净性，故钉住的卡从时间原位
   *  高亮为「已钉住」状态即可（视觉标识 + 取消入口），不做空间位移 */
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set())
  const togglePin = useCallback((id: string) => {
    setPinnedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])
  /** 混排时间线：消息 + 产物卡（文类）按时间序插到其登记位置（宪法：产物在其诞生位置插入）。
   *  定位口径：linkedResource 无 entry 外键（P1 不加列——避免 DB 迁移），用 createdAt 与
   *  消息 ts 对比找首个不早于登记时间的消息插在其前；晚于全部消息则附末尾（=「最新消息位」）。
   *  排序稳定性：message.seq 单调，资源 createdAt 兜底——同刻并列时资源在前（先登记后说话）。 */
  const timeline = useMemo(() => {
    const items: TimelineItem[] = messages.map(m => ({ kind: 'message', ts: m.ts, seq: m.seq ?? 0, message: m }))
    const artifacts = (linkedResources ?? []).filter(r => ['pr', 'file', 'fact'].includes(r.type))
    for (const r of artifacts) {
      const ts = r.createdAt ?? ''
      // 找首个 ts >= 资源 createdAt 的消息，插到它前面（诞生于该消息之前）
      let insertIdx = items.length
      for (let i = 0; i < items.length; i++) {
        if (items[i].ts >= ts) { insertIdx = i; break }
      }
      items.splice(insertIdx, 0, { kind: 'artifact', ts, seq: -1, resource: r })
    }
    return items
  }, [messages, linkedResources])
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
  /** F20261008scpg scroll-pin 状态机——pinRef（true=pinned）是「是否贴底跟随」的单一事实源。
   * 语义升级：旧 isAtBottomRef 是几何快照（每次 scroll 事件重判 isNearBottom），流式增长期
   * 程序贴底写入追不上内容长高 → 事件时距离瞬超 100px 阈值 → 翻 false → 补偿永久停摆 →
   * 视口上方内容高度突变时无保护（自动上跳根因）。新语义意图驱动：
   * - 脱锚（pinned→floating）：仅用户意图——wheel 上滚 / touch 上翻 / 键盘上翻 /
   *   未被账本认领的向上位移（滚动条上拖无专门事件，位移方向是其唯一可观测签名）
   * - 回锚（floating→pinned）：滚至底部附近（isNearBottom，含 clamp 落底）/ 点跳底按钮
   * - 高度变化：不改状态；pinned → 统一贴底补偿，floating → 不打扰
   * 程序写入经 write ledger 自证身份（programScroll 统一入口），不污染用户意图状态 */
  const pinWritesRef = useRef<ScrollLedgerEntry[]>([])
  const rafPinIdRef = useRef(0)
  const lastScrollTopRef = useRef(0)
  const touchStartYRef = useRef<number | null>(null)

  /** 程序性滚动统一入口：所有代码发起的 scrollTop 写入必须走这里（写入点收敛）。
   * 账本完备性依赖此不变量——账本外写入会被归因为用户行为 */
  const programScroll = useCallback((el: HTMLElement, target: number, tag: ScrollWriteTag, behavior: ScrollBehavior = 'auto') => {
    if (behavior === 'auto') el.scrollTop = target
    else el.scrollTo({ top: target, behavior })
    const now = Date.now()
    pinWritesRef.current = pinWritesRef.current.filter(e => now - e.ts < LEDGER_TTL_MS && !e.interrupted)
    pinWritesRef.current.push({ expected: target, tag, interrupted: false, ts: now })
  }, [])

  /** 用户接管滚动：置 floating + 打断在途程序写入（待执行的 rAF 贴底在执行时重读 pin 放弃） */
  const takeUserControl = useCallback(() => {
    pinRef.current = false
    for (const e of pinWritesRef.current) e.interrupted = true
  }, [pinRef])

  /** F20261008scpg（W2/W8 拆分）：本 effect 只保留 W8——上翻加载历史的滚动位置恢复。
   * 旧 W2「条数增加且在底部→贴底」「条数减少（切会话）→贴底」两个分支删除：
   * - 条数增加必然伴随内容高度增大，由 content observer 统一补偿（写入点收敛，消双写竞态）
   * - 切会话由 R0 接管（容器 key remount 的 mount 贴底 + conversationId effect 置 pinned） */
  useEffect(() => {
    const prevLen = prevMessagesLenRef.current
    prevMessagesLenRef.current = messages.length
    if (messages.length === prevLen) return
    if (pendingScrollRestoreRef.current !== null) {
      const el = scrollRef.current
      if (el) programScroll(el, el.scrollHeight - pendingScrollRestoreRef.current, 'restore')
      pendingScrollRestoreRef.current = null
    }
  }, [messages.length, programScroll])

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
   * - 上翻加载历史的 preserve-scroll（pendingScrollRestoreRef 路径）互斥：用户脱锚后
   *   pin=false（F20261008scpg：意图状态机），本机制不动作
   * - 依赖 [conversationId]：滚动容器带 key={conversationId}，切会话时容器重建，
   *   mount-only 会观测已卸载元素而失效——切会话时重挂 observer 并重置采样基线 */
  useEffect(() => {
    const content = contentRef.current
    const viewport = scrollRef.current
    if (typeof ResizeObserver === 'undefined' || (!content && !viewport)) return
    prevContentHeightRef.current = 0
    prevViewportHeightRef.current = 0
    const rafPinToBottom = () => {
      cancelAnimationFrame(rafPinIdRef.current) // 合帧：高频 resize 下每帧至多补偿一次
      rafPinIdRef.current = requestAnimationFrame(() => {
        const sc = scrollRef.current
        // F20261008scpg：执行时重读 pin——rAF 排队期间用户接管则放弃写入（防「抢滚动条」）
        if (sc && pinRef.current) programScroll(sc, sc.scrollHeight, 'pin')
      })
    }
    const contentObserver = content ? new ResizeObserver(entries => {
      const entry = entries[entries.length - 1]
      const h = entry?.contentRect?.height ?? 0
      if (h === prevContentHeightRef.current) return // 高度没变（width-only 等）
      const grew = h > prevContentHeightRef.current
      prevContentHeightRef.current = h
      if (!grew) return // 内容缩短：scrollHeight 缩短自然贴底，不补
      if (!pinRef.current) return // F20261008scpg：用户 floating（自由阅读）：任何高度变化都不打扰
      rafPinToBottom()
    }) : null
    const viewportObserver = viewport ? new ResizeObserver(entries => {
      const entry = entries[entries.length - 1]
      const h = entry?.contentRect?.height ?? 0
      if (h === prevViewportHeightRef.current) return
      const shrank = h < prevViewportHeightRef.current
      prevViewportHeightRef.current = h
      if (!shrank) return // 视口增大：底部内容更可见，不补
      if (!pinRef.current) return
      rafPinToBottom() // 视口被压缩（loadingMore 等）：底部内容被推出视口，拉回
    }) : null
    if (content && contentObserver) contentObserver.observe(content)
    if (viewport && viewportObserver) viewportObserver.observe(viewport)
    return () => { contentObserver?.disconnect(); viewportObserver?.disconnect(); cancelAnimationFrame(rafPinIdRef.current) }
    // Why: 依赖 conversationId——容器带 key 切会话时重建，需重挂 observer；state 入 deps——
    // loading/no-llm 分支不渲染滚动容器（ref 为 null 提前返回），回 normal 时需重挂；
    // 其余状态经 ref 读取，无需重订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, state])

  /** F20261008scpg 滚动事件归因：先账本（程序写入自证），后用户位移分类。
   * 分类序：回锚优先于脱锚——clamp 落底/用户滚到底都是安全方向（默认意图=跟随）；
   * 向上位移脱锚只认「不在底部附近」的位移（滚动条上拖/键盘上翻的无事件兑底签名）。
   * F20260921urdo 判定换轨退役：到底标记已读回调（onReachBottom）已删除（打开路径已 ack） */
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const now = Date.now()
    pinWritesRef.current = pinWritesRef.current.filter(e => now - e.ts < LEDGER_TTL_MS && !e.interrupted)
    /** 向上位移且不在底部：用户接管优先——滚动条上拖兑底签名。程序 pin 写入永远
     *  向底部（不会向上移），匹配到的条目若视口实际向上则必是用户在程序写入后接管 */
    const movedUp = el.scrollTop < lastScrollTopRef.current - 1
    const nearBottom = isNearBottom(el)
    if (movedUp && !nearBottom) {
      takeUserControl()
    } else {
      let attributed = false
      for (let i = pinWritesRef.current.length - 1; i >= 0; i--) {
        const e = pinWritesRef.current[i]
        // pin 目标=写入时底部，流式增长下只升不降，取下界匹配；restore 需精确落位取紧容差
        const hit = e.tag === 'pin'
          ? el.scrollTop >= e.expected - LEDGER_EPS_PX
          : Math.abs(el.scrollTop - e.expected) <= LEDGER_EPS_PX
        if (!hit) continue
        pinWritesRef.current.splice(i, 1)
        attributed = true
        if (e.tag === 'pin' && nearBottom) {
          pinRef.current = true // 终态幂等确认（跳底按钮 smooth 滚动到达的合法回锚来源）
        }
        break
      }
      if (!attributed) {
        if (nearBottom) {
          pinRef.current = true
        }
      }
    }
    // 到达顶部，触发加载更多（位置触发，与 pin 状态无关）
    if (el.scrollTop === 0 && onLoadMore && !loadingMore) {
      // 记录当前滚动高度，加载后恢复
      pendingScrollRestoreRef.current = el.scrollHeight
      onLoadMore()
    }
    lastScrollTopRef.current = el.scrollTop
  }, [onLoadMore, loadingMore, pinRef, takeUserControl])

  /** 首次渲染滚到底部（R0：mount 即 pinned——容器带 key，切会话 remount 时同样经此贴底） */
  useEffect(() => {
    if (messages.length > 0) {
      requestAnimationFrame(() => {
        const el = scrollRef.current
        if (el) programScroll(el, el.scrollHeight, 'pin')
      })
    }
    // Why: mount-only（同旧 W5 语义）。增量贴底由 content observer 统一负责（F20261008scpg 删 W2 双写）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 切换会话时重置状态（R0：新会话 pinned 起步；账本/采样基线一并清空） */
  useEffect(() => {
    pinRef.current = true
    prevMessagesLenRef.current = 0
    pinWritesRef.current = []
    lastScrollTopRef.current = 0
    cancelAnimationFrame(rafPinIdRef.current)
  }, [conversationId, pinRef])

  /** F20261008scpg 意图事件监听：wheel/touch/键盘上滚 = 用户意图脱锚（capture+passive，不拦截不感知几何）。
   * 这三条是「有专门事件」的输入通道；滚动条拖动等无事件手势由 handleScroll 的位移归因兑底覆盖 */
  useEffect(() => {
    const el = scrollRef.current
    if (!el || state !== 'normal') return
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) takeUserControl() }
    const onTouchStart = (e: TouchEvent) => { touchStartYRef.current = e.touches[0]?.clientY ?? null }
    const onTouchMove = (e: TouchEvent) => {
      const startY = touchStartYRef.current
      const cur = e.touches[0]?.clientY
      // 手指下移超阈值 = 内容上翻（脱锚方向）
      if (startY == null || cur == null) return
      if (cur - startY > TOUCH_UNPIN_PX) takeUserControl()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'PageUp' && e.key !== 'Home' && e.key !== 'ArrowUp') return
      // 不劫持输入框光标移动（V9）：目标为输入元素时上翻键属于文本编辑语义
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      // 防御性过滤（代码审视建议 1，前提经核实不成立：iframe 内键盘事件受同源文档隔离，
      // 不会传播到宿主 window——card-bridge.ts 仅监听 load，无键盘转发）。保留作为未来
      // 事件桥接引入时的护栏：目标属于其他文档（iframe）时忽略；window 目标（无
      // ownerDocument）仍处理——测试与辅助技术依赖 window 级分发
      if (t && typeof t.ownerDocument !== 'undefined' && t.ownerDocument !== document) return
      takeUserControl()
    }
    el.addEventListener('wheel', onWheel, { passive: true, capture: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('keydown', onKeyDown)
    return () => {
      el.removeEventListener('wheel', onWheel, { capture: true })
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('keydown', onKeyDown)
    }
    // Why: 同 observer effect——conversationId（容器 key 重建）+ state（loading 分支无容器）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, state])

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
        {/* F20260913ctlv：活动段分组（「新一轮」分隔线）已退役——彻底切换后无轮次概念，
            时间线就是 entries 按序流，invoke 边界由居中条目（⚡/🌙/→）表达 */}
        {/* F20261008csf1 P1：混排渲染——产物摘要卡（文类）插在其登记时间对应的消息位置 */}
        {timeline.map(item => item.kind === 'artifact' ? (
          <div key={`artifact-${item.resource.id}`} className="flex justify-center my-2 animate-slideIn">
            <ArtifactCard resource={item.resource} pinned={pinnedIds.has(item.resource.id)} onTogglePin={togglePin} />
          </div>
        ) : (
          <div key={item.message.id} data-message-id={item.message.id}>
            {unreadSeparatorSeq != null && item.message.seq === unreadSeparatorSeq && (
              <div className="flex items-center gap-2 my-2 mx-auto" style={{ maxWidth: '72%' }}>
                <div className="flex-1 h-px bg-teal-400/40" />
                <span className="text-[10px] text-teal-500 font-medium px-2">未读消息</span>
                <div className="flex-1 h-px bg-teal-400/40" />
              </div>
            )}
            <MessageItem message={item.message} otters={otters} onStopStream={onStopStream} onRetryMessage={onRetryMessage} highlighted={highlightMessageId === item.message.id} userName={userName} />
          </div>
        ))}
        </div>
      </div>
      {newMessagesCount > 0 && onJumpToBottom && (
        <button
          onClick={() => {
            // F20261008scpg W6 修复：滚动与置 pin 在组件内完成（ref 直连滚动容器）；
            // onJumpToBottom 回调只承担计数清零等业务侧处理。旧版 index.tsx 用
            // querySelector('[data-message-list]') 找容器，该属性渲染端不存在（死按钮）
            const sc = scrollRef.current
            if (sc) {
              pinRef.current = true
              programScroll(sc, sc.scrollHeight, 'pin', 'smooth')
            }
            onJumpToBottom()
          }}
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

/** F20261008csf1 P1：图类内联 lightbox——点击缩略图原位放大（遮罩层），再点关闭。
 *  宪法「缩略即全文，点击放大」：不跳新窗口（原实现 target=_blank 打断对话现场）。
 *  Esc/点击遮罩关闭；防滚动穿透（body overflow 临时锁定）。 */
function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 cursor-zoom-out"
      onClick={onClose}
      role="dialog"
      aria-label="图片预览"
    >
      <button
        className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition"
        onClick={onClose}
        aria-label="关闭"
      >
        <X className="w-5 h-5" />
      </button>
      <img
        src={src}
        alt={alt}
        className="max-w-[92vw] max-h-[88vh] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}

/** 多模态 Phase 1：消息内附件渲染。图片网格缩略图（点击原位放大——F20261008csf1 图类
 *  内联 lightbox 取代原新窗口打开）+ document/audio/video 文件卡（点击下载；audio 用原生
 *  控件回放，#608）。
 *  同一端点 /api/attachments/:id，image inline / 其他 attachment。
 *  为什么用后端端点而非 base64 内嵌：DTO 只带引用（id/尺寸），消息体积不变，缓存友好（immutable） */
function AttachmentBlock({ atts, isUser }: { atts: LocalAttachment[]; isUser: boolean }) {
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const images = atts.filter(a => a.kind === 'image')
  const audios = atts.filter(a => a.kind === 'audio')
  // document + video 均为文件卡下载样式（检视建议 4：显式命名，未来 video 需特殊渲染时从此处拆出）
  const documentsAndVideos = atts.filter(a => a.kind !== 'image' && a.kind !== 'audio')
  return (
    <div className="mt-2 space-y-2">
      {images.length > 0 && (
        <div className={`grid gap-1.5 ${images.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {images.map(a => (
            <button
              key={a.id}
              onClick={() => setLightbox({ src: `/api/attachments/${a.id}`, alt: a.originalName })}
              className="block text-left cursor-zoom-in"
              aria-label={`放大查看 ${a.originalName}`}
            >
              <img
                src={`/api/attachments/${a.id}`}
                alt={a.originalName}
                loading="lazy"
                className={`rounded-xl object-cover hover:opacity-90 transition ${images.length > 1 ? 'w-full aspect-square' : 'max-w-[260px] max-h-[260px]'} ${isUser ? 'border border-white/60' : 'border border-black/5'}`}
              />
            </button>
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
      {lightbox && <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </div>
  )
}

function MessageItem({ message: m, otters, onStopStream, onRetryMessage, highlighted, userName }: { message: Message; otters: Otter[]; onStopStream: (messageId: string) => void; onRetryMessage: (messageId: string) => void; highlighted?: boolean; userName?: string }) {
  // F20260913ctlv：invoke 边界/yield 居中条目（无气泡，图标+文字；与 system 同层但更轻量）
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
  // F20260913ctlv test17：web 来源不算「外部」——remoteFallbackName 只对明确的外部 IM 来源生效，
  // web/空 source 回退全局名（「我」）
  const snapshotName = isUser ? (m.sn || '').trim() : ''
  const remoteFallbackName = m.src === 'feishu' ? '飞书成员' : ''
  const name = isUser ? (snapshotName || remoteFallbackName || userDisplayName) : resolveDisplayName(m, otters)
  // F20260921otcl：消息自带身份优先（事件携带 scolor），名册补充 type；均缺失时
  //  resolveOtterVisual 内部 fnv1a 展示回退——大獭判定优先消息/名册 type
  const otterInfo = otters.find(o => o.id === m.si)
  const { color } = isUser ? { color: null } : resolveOtterVisual(m.si, {
    type: otterInfo?.type,
    color: m.scolor != null ? m.scolor : otterInfo?.color,
  })
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
          className="w-9 h-9 rounded-full flex-shrink-0 mt-0.5 msg-avatar shadow-bubble object-cover"
          style={{ border: '2px solid #6B6157' }}
        />
      ) : (
        <div className="mt-0.5">
          <OtterAvatar otterId={m.si} name={name} type={otterInfo?.type} color={m.scolor != null ? m.scolor : otterInfo?.color} />
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
          {/* F20260913ctlv 切换清扫：StreamingProcess 气泡内流式折叠区已退役——
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
                    <MarkdownContent variant={isUser ? 'user-body' : 'otter-body'} messageId={m.id} authorId={m.si} cardSchemaVersion={m.cardSchemaVersion}>{seg.body}</MarkdownContent>
                    <div className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition">
                      <CopyButton text={seg.body} />
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <div className="relative group">
              {m.content
                ? <MarkdownContent variant={isUser ? 'user-body' : 'otter-body'} messageId={m.id} authorId={m.si} cardSchemaVersion={m.cardSchemaVersion}>{m.content}</MarkdownContent>
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
        {/* F20260913ctlv 收尾：user 气泡传递行在气泡外（下方一行小字）——气泡内只放说话内容。
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

