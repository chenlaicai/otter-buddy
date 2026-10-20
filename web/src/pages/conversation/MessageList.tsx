import { useEffect, useLayoutEffect, useRef, useState, useCallback, createContext, useContext, useMemo, isValidElement, type CSSProperties, type ComponentProps, type RefObject } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Element as HastElement } from 'hast'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { AlertTriangle, Square, Copy, Check, Clock, RotateCcw, FileText, Zap, Moon, ArrowRight, X, Wrench, Brain, MessageSquare, User } from 'lucide-react'
import type { LocalMessage as Message, LocalOtter as Otter, LocalAttachment } from '../../lib/mappers'
import { deriveEntryType, centeredEntryText } from '../../lib/mappers'
import { OTTER_GRADIENT } from '../../lib/otter-colors'
import { resolveOtterVisual } from '../../lib/otter-visual'
import { getUserAvatar } from '../../lib/otter-avatars'
import { OtterAvatar } from '../../components/OtterAvatar'
import { fmtTokens, ctxPercent, fmtTime } from '../../lib/utils'
import { withIdentity } from '../../api/identity'
import { fmtBytes } from '../../lib/attachments'
import { parseCardTitle, parseCardImportance, extractFoldedSummary } from '../../lib/html-card'
import { remarkHtmlCardIndex } from '../../lib/remark-html-card-index'
import { remarkBareLink } from '../../lib/remark-bare-link'
import { remarkAutolinkTrim } from '../../lib/remark-autolink-trim'
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

  if (className === 'language-html-card' || className === 'language-html-card-play') {
    // 事件流文本的 fenceIndex 与 message.body 不对应，一律源码块（不进 registry）
    if (ctx.variant === 'event-log') return highlightSource('html', text)
    // fenceIndex 经 remark 插件 hProperties 通道写入（mdast→hast 不透传任意 data key）。
    // fail-closed：注解缺失时不能猜 0（会张冠李戴到首张卡），降级为源码块
    const rawFenceIndex = node?.properties?.dataFenceIndex
    if (rawFenceIndex == null) return highlightSource('html', text)
    const fenceIndex = Number(rawFenceIndex)
    // F20261009csp2：活类标记（html-card-play 围栏由插件写入）
    const playable = node?.properties?.dataPlayable === true
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
        playable={playable}
        importance={parseCardImportance(meta)}
        foldedSummary={extractFoldedSummary(text)}
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
    if (cls === 'language-html-card' || cls === 'language-html-card-play' || cls === 'language-html-card-reply') return <>{children}</>
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
  // F20261020wabt：autolink 全角尾巴修剪须在 remarkBareLink 之前——裸链判定依赖
  // 修剪后的 url===text，顺序反了带尾巴的裸链 url 与 text 同步修剪仍一致，但
  // 防御顺序敏感（后续插件读的是本插件修过的 url），固定放前。
  remarkAutolinkTrim,
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

export { MarkdownContent }



/** F20261008scpg scroll-pin 状态机常量：touch 脱锚位移阈值（账本常量 LEDGER_TTL_MS/LEDGER_EPS_PX
 *  与 F20261020lmld 近顶触发带 LOAD_MORE_TOP_PX 已随 F20261020wcsr 退役——触发改哨兵，账本删除） */
const TOUCH_UNPIN_PX = 10
/** F20261020wcsr：哨兵预触发带（px）——哨兵距视口顶 200px（≈2-4 条消息）即开始加载，
 *  「还没到顶就已备好」的微信手感；取 0 则用户到顶才开始等加载 */
const SENTINEL_ROOT_MARGIN_PX = 200
/** F20261020wcsr：连拉限幅——用户停在顶部时自动连拉上限（批）。无上限=一口气拉完全量
 *  （F20261020lmld 注释口径不可接受）；有上限保阅读意图。冷却只约束自动通道，手动按钮不受限。
 *  解除通道：handleScroll 检测向下位移（用户离开顶部）即重置。故障模式=哨兵静默（同 lmld
 *  死锁形态），逃生口=可见按钮（手动通道不受限） */
const AUTO_CHAIN_MAX_BATCHES = 3

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
  /** F20261016inbs：底部衬垫高度（px）——输入覆盖层实高，由 ChatView ResizeObserver 实测。
   *  旧方案是视口 paddingBottom 写死 170px（单行输入实高 ~72px → 滚到底时最后一条消息
   *  悬在输入框上方 ~98px 死区；附件/错误行超高时反向压住消息底部）。新方案：视口零 padding
   *  （F20261015inpd 视口恒定成果保持），预留搬到滚动内容末尾等高衬垫——衬垫随覆盖层实高
   *  动态变化，pinned 用户由既有贴底补偿保持齐平（衬垫长高也是内容长高，contentObserver
   *  兑底），floating 用户不打扰 */
  bottomSpacerPx?: number
  /** 跳底按钮回调：滚动与置 pin 在本组件内完成，回调只承担计数清零等业务侧处理 */
  onJumpToBottom?: () => void
  onLoadMore?: () => void
  loadingMore?: boolean
  /** F20261020lmld：是否还有更早历史——控制顶部可见入口渲染（false/缺省不渲染，防假入口） */
  hasMoreBefore?: boolean
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
  conversationId, pinRef, newMessagesCount = 0, bottomSpacerPx = 0, onJumpToBottom, onLoadMore,
  loadingMore, hasMoreBefore = false,
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
    // 窗口下界：消息分页拉取（首拉 50、上翻 20）而 linkedResources 一次全量——
    // 不设下界时，早于窗口最早消息的产物会聚集在时间轴顶部（检视发现 2：上翻到老区间
    // 后视口内无诞生位置的卡，顶部悬浮一排旧卡冒充「最早」）。与消息分页语义对齐：
    // 窗口外产物不显示，上翻加载到覆盖其诞生时刻时自然出现
    const windowFloor = messages.length ? messages[0].ts : ''
    const artifacts = (linkedResources ?? [])
      .filter(r => ['pr', 'file', 'fact'].includes(r.type) && r.status === 'active')
      .filter(r => (r.createdAt ?? '') >= windowFloor)
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
  /** F20261020wcsr：顶部哨兵 ref——IntersectionObserver 观测目标（哨兵分页） */
  const sentinelRef = useRef<HTMLDivElement>(null)
  /** F20261020wcsr：连拉计数——停在顶部自动连拉批次，达 AUTO_CHAIN_MAX_BATCHES 冷却 */
  const autoChainCountRef = useRef(0)
  /** 头部消息 id 采样：区分「头部追加（上翻加载）」与「尾部追加（新消息）」 */
  const lastFirstIdRef = useRef<string | null>(null)
  /** F20261020wcsr scrollTop=0 兜底采样基线（规范 §2.1 边界：锚点不选「未离开原点」的容器，
   *  绝对顶部 prepend 浏览器锚定不工作，需极简手写补偿）。采样点与 lastScrollTopRef 同处
   *  （handleScroll 末尾）；conversationId 采样供「同会话」守卫（key remount 下 scrollTop=0
   *  语义从「用户在顶部」漂移为「新容器刚 mount」，跨容器采样=垃圾写入——镜澜严重发现 2） */
  const prevScrollTopAtCommitRef = useRef(0)
  const prevScrollHeightAtCommitRef = useRef(0)
  const fallbackConvIdRef = useRef(conversationId)
  /** F20260907sgpt：上次采样的内容高度（contentObserver 记录）。
   *  F20261010vwst：视口高度采样基线（prevViewportHeightRef）随 viewportObserver 一并删除 */
  const prevContentHeightRef = useRef(0)
  /** F20261008scpg scroll-pin 状态机——pinRef（true=pinned）是「是否贴底跟随」的单一事实源。
   * 语义：意图驱动——
   * - 脱锚（pinned→floating）：仅用户意图——wheel 上滚 / touch 上翻 / 键盘上翻 /
   *   向上位移（滚动条上拖无专门事件，位移方向是其唯一可观测签名）
   * - 回锚（floating→pinned）：滚至底部附近（isNearBottom，含 clamp 落底）/ 点跳底按钮
   * - 高度变化：不改状态；pinned → 统一贴底补偿，floating → 不打扰
   * F20261020wcsr：write ledger 账本退役——向上位移脱锚规则（F20261016inbs）使程序写入
   * （pin/兜底均构造性向下）几何上不可能命中脱锚分支，误判通道被方向封闭（论证见特性文档） */
  const rafPinIdRef = useRef(0)
  const lastScrollTopRef = useRef(0)
  /** F20261016inbs：上次采样的 scrollHeight——内容收缩判定基线（handleScroll 内比对），
   *  采样点与 lastScrollTopRef 同一处（handleScroll 末尾），中间无观测缺口 */
  const lastScrollHeightRef = useRef(0)
  const touchStartYRef = useRef<number | null>(null)

  /** 程序性滚动统一入口（F20261020wcsr：账本删除后语义收窄为「写入点收敛」——
   *  所有代码发起的 scrollTop 写入走这里，便于审计写入方向不变量：全部写入构造性向下） */
  const programScroll = useCallback((el: HTMLElement, target: number, behavior: ScrollBehavior = 'auto') => {
    if (behavior === 'auto') el.scrollTop = target
    else el.scrollTo({ top: target, behavior })
  }, [])

  /** 用户接管滚动：置 floating + 打断在途 rAF 贴底（执行时重读 pin 放弃） */
  const takeUserControl = useCallback(() => {
    pinRef.current = false
  }, [pinRef])

  /** F20261020wcsr 加载触发（哨兵/按钮共用）。重入口径沿用 F20261020lmld 检视 A2 修正：
   *  loadingMore prop 拦事件级重复；同步硬闸在父层 loadingMoreRef（index.tsx loadMoreBefore
   *  入口）——prop 回传有事件→setState→prop 间隙，极端连击下靠父层同步 ref 兜底。
   *  位置保持（距顶恢复链）已退役——prepend 由浏览器 scroll anchoring 保持；scrollTop=0
   *  边界由 useLayoutEffect 兜底（采样基线 prevScrollHeightAtCommitRef 在 commit 后采样）。 */
  const fireLoadMore = useCallback(() => {
    if (!onLoadMore || loadingMore) return
    onLoadMore()
  }, [onLoadMore, loadingMore])

  /** F20261008f1fx 零间隙贴底（H1 修复）：DOM commit 后、浏览器绘制前同步写入底部（useLayoutEffect 同步语义，
   *  非 useEffect——后者在绘制后，间隙仍在）。第一轮（F20261008scpg）的 RO→rAF 链存在
   *  结构性 1-2 帧间隙：内容突变那帧贴底用户滚动条比例骤降（视觉=跳到中间），下一帧才
   *  补偿回来——大量级突变（卡片撑高数百 px）时肉眼可见。useLayoutEffect 在绘制前同步写，
   *  间隙帧归零。
   *  与 RO 链分工：本 effect 捕 React commit 驱动的高度变化（新消息/流式增量/重渲染）；
   *  transition/CSS/iframe 驱动的高度变化不走 React commit，仍由 RO 链兑底。
   *  写入统一经 programScroll（写入点收敛）。
   *  注意：不能读「渲染前旧高度」做差值补偿——useLayoutEffect 时 DOM 已 commit。pinned
   *  场景无需差值：直接贴底即是目标位置。依赖全量跑（无 deps）：流式期间每轮 commit 都是
   *  高度变化点，逐次同步贴底，代价是 floating 时早退（一次 ref 读）。
   *  防误修：与 RO 链对同一高度变化可能「双写」（f1fx commit 写一次 + RO 回调再写一次）——
   *  幂等无害（两次都写 scrollHeight），不要为「去重」拆任一条链。
   *
   *  F20261020wcsr：prepend 位置保持主力移交浏览器 scroll anchoring（overflow-anchor 默认开）。
   *  本 effect 内的 scrollTop=0 兜底只覆盖规范 §2.1 边界：锚点不选「未离开原点」的容器——
   *  用户在绝对顶部触发加载时浏览器无锚可用，prepend 会把视口顶下去，需极简手写补偿。
   *  兜底三条件（全真才触发，镜澜审视修订）：
   *  ①conversationId 未变（key remount 下 scrollTop=0 语义从「用户在顶部」漂移为
   *    「新容器刚 mount」，跨容器采样=垃圾写入）；②上一轮采样 scrollTop===0；
   *  ③头部消息 id 变化（确认为 prepend 而非其他消息流变化）。
   *  写入约束：位移增量式 max(scrollTop + delta, 0)——增量非负由 max 构造保证
   *  （delta<0 同帧收缩时钳零原地不动），方向构造性封闭，不产生向上位移→不命中脱锚。
   *  弱前提（镜澜 delta-D1）：条件②采样一致性依赖 scroll 事件与 React commit 的任务排序，
   *  破坏后果为幂等抢跑一次锚定本可完成的调整（位移仍向下），无位置错乱。 */
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // 采样基线推进在 effect 顶部——读本轮 commit 前的 DOM 真实值（commit 阶段程序写入
    // 尚未执行，此时 scrollTop/scrollHeight 恰是「上轮 commit 后、本轮 commit 前」的用户
    // 停留位置与内容高度）。若放 effect 底部（写入之后），程序 pin 写入会污染采样语义
    // （条件②要看的是用户停留位置，不是贴底后的值）；若放 handleScroll（事件时），
    // commit 到 paint 的窗口内「滚动事件已采样、布局未提交」的时序使采样滞后一轮
    // （自测发现：prepend 后 handleScroll 采样把新 scrollHeight 当基线，delta=0 漏兜底）
    const prevTop = prevScrollTopAtCommitRef.current
    const prevSh = prevScrollHeightAtCommitRef.current
    const prevFirstId = lastFirstIdRef.current
    const prevConv = fallbackConvIdRef.current
    prevScrollTopAtCommitRef.current = el.scrollTop
    prevScrollHeightAtCommitRef.current = el.scrollHeight
    fallbackConvIdRef.current = conversationId
    const sameConv = prevConv === conversationId
    // 头部 id 采样同步推进（替代旧 [messages] effect 维护）：paint 前语义保证
    // 「本轮 commit 的 lastFirstIdRef 仍是上一轮值」，headChanged 恰为「本轮 prepend」
    const headChanged = messages.length > 0 && prevFirstId !== null && prevFirstId !== messages[0]?.id
    if (messages.length > 0) lastFirstIdRef.current = messages[0]?.id ?? null
    if (sameConv && prevTop === 0 && prevSh > 0 && headChanged) {
      // 绝对顶部 prepend 兜底（规范 §2.1 不选锚边界）：位移增量式写入，方向构造性封闭
      const delta = el.scrollHeight - prevSh
      if (delta > 0) programScroll(el, el.scrollTop + delta)
    }
    if (!pinRef.current) return
    programScroll(el, el.scrollHeight)
  })

  /** F20260907sgpt 高度贴底补偿 + F20261010vwst 视口稳定优先（单 observer 化）。
   *
   * 背景：自 virtuoso→原生滚动迁移（F20260813scrl）起曾设 overflowAnchor:'none'（原生滚动
   * 锚定关闭，F20261020wcsr 已重新启用——专项研究：关锚定后枚举高度源补丁路线不可持续，
   * F20261010vwst 判死刑；浏览器锚定是规范为此设计的原生机制），且「messages.length effect」
   * 只对条数变化补偿——而信号轨迹 chip（trailItems 2s 轮询异步到达）、信号徽标（SSE 终态
   * 替换 tmp- 消息，条数不变）等都只在视口内增减内容高度，条数不变 → 无补偿 → 用户在底部
   * 时视口周期性上跳（#790 只修了发言时刻未读分隔线那一条路）。
   *
   * 修法：contentObserver 观测内容包裹 div（contentRef）：contentRect.height = 内容总
   *   高度，chip 弹出/徽标出现/流式增长时真实变化。内容高度增大且 pinned → 贴底。
   *   （不可观测滚动容器：容器 contentRect.height 是视口布局高度，内容变化不触发——
   *   首版实现踩过的坑，jsdom 测试手动 fire 回调掩盖了这一点）
   *
   * F20261010vwst 删除 viewportObserver（稳定性设计原则落地）：视口高度变化时浏览器对
   * scrollTop 的 clamp 语义天然保证内容稳定，程序补偿反而制造跳动（输入框 autoResize 顶起
   * 事故，滚动治理第 9 轮）。删除后行为变化与取舍详见特性文档 F20261010vwst。
   *
   * 边界处理：
   * - 内容高度减小（流式面板折叠等）：scrollHeight 缩短自然把视口推近底部，
   *   isNearBottom 重判，无需补偿
   * - requestAnimationFrame 合帧：高频 resize（流式渲染）下每帧至多补偿一次
   * - floating 用户（F20261008scpg 意图状态机）：任何高度变化都不打扰——floating 态的
   *   视觉稳定由浏览器 scroll anchoring 承担（F20261020wcsr），不再枚举补偿
   * - 依赖 [conversationId]：滚动容器带 key={conversationId}，切会话时容器重建，
   *   mount-only 会观测已卸载元素而失效——切会话时重挂 observer 并重置采样基线 */
  useEffect(() => {
    const content = contentRef.current
    if (typeof ResizeObserver === 'undefined' || !content) return
    prevContentHeightRef.current = 0
    const rafPinToBottom = () => {
      cancelAnimationFrame(rafPinIdRef.current) // 合帧：高频 resize 下每帧至多补偿一次
      rafPinIdRef.current = requestAnimationFrame(() => {
        const sc = scrollRef.current
        // F20261008scpg：执行时重读 pin——rAF 排队期间用户接管则放弃写入（防「抢滚动条」）
        if (sc && pinRef.current) programScroll(sc, sc.scrollHeight)
      })
    }
    const contentObserver = new ResizeObserver(entries => {
      const entry = entries[entries.length - 1]
      const h = entry?.contentRect?.height ?? 0
      if (h === prevContentHeightRef.current) return // 高度没变（width-only 等）
      const grew = h > prevContentHeightRef.current
      prevContentHeightRef.current = h
      if (!grew) return // 内容缩短：scrollHeight 缩短自然贴底，不补
      if (!pinRef.current) return // F20261008scpg：用户 floating（自由阅读）：任何高度变化都不打扰
      rafPinToBottom()
    })
    contentObserver.observe(content)
    return () => { contentObserver.disconnect(); cancelAnimationFrame(rafPinIdRef.current) }
    // Why: 依赖 conversationId——容器带 key 切会话时重建，需重挂 observer；state 入 deps——
    // loading/no-llm 分支不渲染滚动容器（ref 为 null 提前返回），回 normal 时需重挂；
    // hasMessages 入 deps（F20261008f1fx 检视发现 5）：冷启动/首次打开会话首渲染 messages=[]
    // 走空态分支（不渲染滚动容器），effect 挂载时 refs=null 早退；随后消息到达 deps 无变化
    // 永不重跑——RO 链自 F20260907sgpt 起在冷启动会话从未挂载（插桩实锤：组件 RO 零 fire，
    // 同页对照 RO fire 3 次）。布尔翻转 0→1 恰好触发重挂，重挂时基线重置已由上方
    // prevContentHeightRef = 0 处理；其余状态经 ref 读取，无需重订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, state, messages.length > 0])

  /** F20261020wcsr 哨兵分页：顶部 IntersectionObserver 替代 F20261020lmld 手写多通道触发
   * （scroll 近顶带/wheel/touch/keyDown 四通道退役；可见按钮保留为手动通道）。
   * 结构性免疫 lmld 死锁：IO 不依赖滚动事件——到顶静止后哨兵 intersecting 状态变化
   * 仍触发回调（lmld 死锁根因=零位移无 scroll 事件，对 IO 不构成问题）。
   * 连拉限幅：停在顶部自动连拉 ≤AUTO_CHAIN_MAX_BATCHES 批后冷却；解除=handleScroll
   * 检测向下位移（用户离开顶部）。冷却只约束自动通道，手动按钮不受限（不得做成全局闸）。
   * 生命周期：hasMoreBefore=false 时哨兵不渲染（render 处条件）→ 本 effect 经 deps 重跑时
   * observe 目标为 null 自然不挂；切会话连拉计数重置。 */
  useEffect(() => {
    const sentinel = sentinelRef.current
    const root = scrollRef.current
    if (typeof IntersectionObserver === 'undefined' || !sentinel || !root) return
    const io = new IntersectionObserver(entries => {
      const entry = entries[entries.length - 1]
      if (!entry?.isIntersecting) return
      if (loadingMore || !hasMoreBefore) return
      if (autoChainCountRef.current >= AUTO_CHAIN_MAX_BATCHES) return // 冷却中（自动通道静默；手动按钮不受限）
      autoChainCountRef.current += 1
      fireLoadMore()
    }, { root, threshold: 0, rootMargin: `${SENTINEL_ROOT_MARGIN_PX}px 0px 0px 0px` })
    io.observe(sentinel)
    return () => io.disconnect()
    // Why: hasMoreBefore/loadingMore 翻转需重评估哨兵（hasMoreBefore=false 时 render 卸载哨兵，
    // effect 清理；loadingMore 完成后再 intersecting 需重新判定连拉）；fireLoadMore 随 props 重绑
  }, [conversationId, state, hasMoreBefore, loadingMore, fireLoadMore])

  /** F20261008scpg 滚动事件处理（F20261020wcsr 账本退役简化版）：位移方向分类 + 连拉冷却解除。
   * 分类序：回锚优先于脱锚——clamp 落底/用户滚到底都是安全方向（默认意图=跟随）；
   * 向上位移脱锚 F20261016inbs 起不受 100px nearBottom 阈值限制（见下方内联注释）。
   * 账本退役论证（特性文档 F20261020wcsr）：本特性落地后全部程序写入（pin 贴底/scrollTop=0
   * 兜底增量写入）方向构造性向下或钳零，几何上不可能命中 movedUp 分支——「程序写入污染
   * 用户意图」通道被方向封闭，账本自证机制成为冗余。
   * F20260921urdo 判定换轨退役：到底标记已读回调（onReachBottom）已删除（打开路径已 ack） */
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    /** 向上位移：用户接管——滚动条上拖/键盘上翻的无事件兑底签名。程序写入永远向底部
     *  （不会向上移），向上位移必然是用户行为（F20261020wcsr：该不变量由写入方向构造保证，
     *  不再依赖账本自证）。
     *  F20261016inbs 弹回修复：账本未归因的向上位移一律脱锚，不受 nearBottom 阈值限制。
     *  唯一例外：scrollHeight 缩小时浏览器 clamp 引发的向上位移是被动几何调整（内容收缩
     *  把 scrollTop 压低），不是用户意图——收缩期间不脱锚，pinned 用户保持 pinned */
    const movedUp = el.scrollTop < lastScrollTopRef.current - 1
    const shrank = el.scrollHeight < lastScrollHeightRef.current - 1
    const nearBottom = isNearBottom(el)
    if (movedUp && !shrank) {
      takeUserControl()
    } else if (nearBottom) {
      // 非向上位移滚到底部附近 → 回锚合法（向下滚回底部/收缩 clamp 落底/pinned 保持）
      pinRef.current = true
    }
    // F20261020wcsr：向下位移 = 用户离开顶部 → 解除哨兵连拉冷却（恢复自动加载资格）
    if (el.scrollTop > lastScrollTopRef.current && autoChainCountRef.current > 0) {
      autoChainCountRef.current = 0
    }
    lastScrollTopRef.current = el.scrollTop
    lastScrollHeightRef.current = el.scrollHeight
  }, [pinRef, takeUserControl])

  /** 首次渲染滚到底部（R0：mount 即 pinned——容器带 key，切会话 remount 时同样经此贴底） */
  useEffect(() => {
    if (messages.length > 0) {
      requestAnimationFrame(() => {
        const el = scrollRef.current
        if (el) programScroll(el, el.scrollHeight)
      })
    }
    // Why: mount-only（同旧 W5 语义）。增量贴底由 content observer 统一负责（F20261008scpg 删 W2 双写）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 切换会话时重置状态（R0：新会话 pinned 起步；采样基线/连拉计数一并清空）
   *  F20261020wcsr：pendingScrollRestoreRef 随恢复链退役删除；autoChainCountRef 重置
   *  （新会话重新获得连拉额度） */
  useEffect(() => {
    pinRef.current = true
    lastScrollTopRef.current = 0
    lastScrollHeightRef.current = 0
    autoChainCountRef.current = 0
    cancelAnimationFrame(rafPinIdRef.current)
  }, [conversationId, pinRef])

  /** F20261008scpg 意图事件监听：wheel/touch/键盘上滚 = 用户意图脱锚（capture+passive，不拦截不感知几何）。
   * 这三条是「有专门事件」的输入通道；滚动条拖动等无事件手势由 handleScroll 的位移归因兑底覆盖。
   * F20261020wcsr：三通道内的「近顶带触发加载」随哨兵分页退役——加载触发统一走
   * IntersectionObserver 哨兵（到顶零位移无 scroll 事件的死锁形态对 IO 不构成问题）；
   * 本 effect 只剩脱锚语义。 */
  useEffect(() => {
    const el = scrollRef.current
    if (!el || state !== 'normal') return
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) takeUserControl()
    }
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
    // Why: conversationId（容器 key 重建）+ state（loading 分支无容器）时重建监听
  }, [conversationId, state, takeUserControl])

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
    // F20261016inbs：视口 paddingBottom 写死 170px 已删——预留搬到滚动内容末尾等高衬垫
    // （下方 bottomSpacer div）。视口 clientHeight 恒定（F20261015inpd 根治成果）不可回退：
    // 任何「改视口高度」的补偿路径都会重新引入 clamp 跳动机制链
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
      {loadingMore && (
        <div className="text-center py-2 text-xs text-stone-400">加载中...</div>
      )}
      <div
        key={conversationId}
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {/* F20260907sgpt 检视发现 1：内容包裹 div——ResizeObserver 观测目标。
            不可直接观测滚动容器（其 contentRect.height 是视口布局高度，内容变化不触发）。
            普通 block div 高度随内容真实变化；包一层对布局无影响（block 默认占满宽度） */}
        <div ref={contentRef}>
        {/* F20261020wcsr：顶部哨兵——IntersectionObserver 观测目标（哨兵分页主力通道）。
            hasMoreBefore=false 不渲染（与可见按钮「防假入口」对称；哨兵卸载即自动通道关闭） */}
        {hasMoreBefore && <div ref={sentinelRef} aria-hidden="true" data-testid="load-sentinel" style={{ height: 1 }} />}
        {/* F20261020lmld：可见加载入口（F20261020wcsr 保留为手动通道——哨兵自动加载的
            可发现性补充 + 连拉冷却中的不受限出口） */}
        {hasMoreBefore && (
          <div className="flex justify-center py-2">
            <button
              onClick={fireLoadMore}
              disabled={loadingMore}
              className="px-3 py-1 text-xs rounded-full text-stone-500 bg-stone-100 hover:bg-stone-200 disabled:opacity-50"
            >
              {loadingMore ? '加载中...' : '加载更早消息'}
            </button>
          </div>
        )}
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
        {/* F20261016inbs：底部衬垫——高度 = 输入覆盖层实高（bottomSpacerPx，ChatView
            ResizeObserver 实测后透传）。渲染在 contentRef（内容包裹 div）末尾：衬垫是滚动
            内容的一部分，contentObserver 能观测其长高/缩短，pinned 用户由既有贴底补偿保持
            齐平（与消息长高同一路径），floating 用户不被打扰。aria-hidden：无语义内容 */}
        {bottomSpacerPx > 0 && <div aria-hidden="true" data-testid="bottom-spacer" style={{ height: bottomSpacerPx }} />}
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
              programScroll(sc, sc.scrollHeight, 'smooth')
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
              onClick={() => setLightbox({ src: withIdentity(`/api/attachments/${a.id}`), alt: a.originalName })}
              className="block text-left cursor-zoom-in"
              aria-label={`放大查看 ${a.originalName}`}
            >
              <img
                src={withIdentity(`/api/attachments/${a.id}`)}
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
            <audio key={a.id} controls preload="none" src={withIdentity(`/api/attachments/${a.id}`)} className="w-full max-w-[320px] h-10" />
          ))}
        </div>
      )}
      {documentsAndVideos.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {documentsAndVideos.map(a => (
            <a
              key={a.id}
              href={withIdentity(`/api/attachments/${a.id}`)}
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
    // F20261013csv3 T5：过程明细（foldedEvents 携带时渲染——开关打开 + 后端投影返回）
    const steps = m.foldedEvents
    return (
      <div className="flex flex-col items-center my-1.5 animate-slideIn">
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
        {/* T5：工具调用过程明细（折叠步——call/think/speak/error/user 五形） */}
        {steps && steps.length > 0 && (
          <div className="mt-1.5 w-full max-w-md rounded-xl border border-stone-200/50 bg-stone-50/40 px-3 py-2 space-y-1">
            <div className="text-[10px] text-stone-400 mb-1">过程明细（{steps.length} 步）</div>
            {steps.map((s, i) => <FoldedStepRow key={i} step={s} />)}
          </div>
        )}
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


/** F20261013csv3 T5：折叠后的工具调用步渲染（call/think/speak/error/user 五形——
 *  后端 foldInvokeEvents 投影，error 摘要 ≤200 字符，每 invoke ≤20 条） */
function FoldedStepRow({ step }: { step: import('@contract/api').FoldedStepDTO }) {
  switch (step.kind) {
    case 'call': {
      const status = step.interrupted ? '已中断' : step.pending ? '执行中' : step.isError ? '失败' : '完成'
      const statusColor = step.interrupted ? 'text-stone-400'
        : step.pending ? 'text-amber-500'
        : step.isError ? 'text-red-500'
        : 'text-teal-600'
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-stone-600 min-w-0">
          <Wrench className="w-3 h-3 text-stone-400 flex-shrink-0" />
          <span className="font-medium truncate">{step.name}</span>
          <span className={`flex-shrink-0 ${statusColor}`}>{status}</span>
          <span className="msg-meta text-[10px] flex-shrink-0 ml-auto">{fmtTime(step.ts)}</span>
        </div>
      )
    }
    case 'think':
      return (
        <div className="flex items-start gap-1.5 text-[11px] text-stone-500 min-w-0">
          <Brain className="w-3 h-3 text-stone-400 flex-shrink-0 mt-0.5" />
          <span className="truncate flex-1" title={step.text}>思考：{step.text.slice(0, 100)}{step.text.length > 100 ? '…' : ''}</span>
        </div>
      )
    case 'speak':
      return (
        <div className="flex items-start gap-1.5 text-[11px] text-stone-500 min-w-0">
          <MessageSquare className="w-3 h-3 text-stone-400 flex-shrink-0 mt-0.5" />
          <span className="truncate flex-1" title={step.body}>发言：{step.body.slice(0, 100)}{step.body.length > 100 ? '…' : ''}</span>
        </div>
      )
    case 'error':
      return (
        <div className="flex items-start gap-1.5 text-[11px] text-red-500 min-w-0">
          <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
          <span className="truncate flex-1" title={step.message}>{step.message.slice(0, 150)}{step.message.length > 150 ? '…' : ''}</span>
        </div>
      )
    case 'user':
      return (
        <div className="flex items-start gap-1.5 text-[11px] text-stone-500 min-w-0">
          <User className="w-3 h-3 text-stone-400 flex-shrink-0 mt-0.5" />
          <span className="truncate flex-1" title={step.text}>注入：{step.text.slice(0, 100)}{step.text.length > 100 ? '…' : ''}</span>
        </div>
      )
  }
}
