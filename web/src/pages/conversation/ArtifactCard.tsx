import { useState } from 'react'
import { GitPullRequest, FileText, Lightbulb, Pin, PinOff, ExternalLink, Gamepad2, Maximize2 } from 'lucide-react'
import type { LocalLinkedResource } from '../../lib/mappers'
import { GameEmbedPanel, resolveGameEmbedPath } from './GameEmbedPanel'
import { Modal } from '../../components/Modal'

/** F20261008csf1 P1：文类产物摘要卡。
 *
 * 宪法定义：文类 = PR/F-R 文档/报告/fact，中间栏展示形态 = 摘要卡（diff 统计/首段摘要/结论
 * 数字），点击进全文。视觉与消息气泡强区分（边框+底色+类型徽章）——混排可扫读性的来源。
 *
 * 数据源口径（为何 PR 卡只有标题/URL/时间）：
 *  - linked_resources 表对 pr 类型只存 title+url+metadata（无 diff 统计列）——diff/CI 状态
 *    需要额外接 gh API，本期不做（宪法 P1 范围：数据现成）；卡片信息增量 = 类型徽章 + 标题 +
 *    登记人 + 时间 + 直达链接
 *  - file 类型同（title+url）；fact 类型有 content 本体（≤500 字），摘要卡直接显示全文
 *  - 点击行为：url 存在新窗口打开（「点击进详情」）；无 url 的 fact 展开全文（fact 全文
 *    ≤500 字，卡内直接展示，无需展开）
 */

/** 类型徽章配置：图标 + 底色 + 文案 */
const TYPE_BADGES: Record<string, { label: string; icon: typeof FileText; badgeClass: string }> = {
  pr: { label: 'PR', icon: GitPullRequest, badgeClass: 'bg-emerald-50 text-emerald-600 border-emerald-200/60' },
  file: { label: '文档', icon: FileText, badgeClass: 'bg-sky-50 text-sky-600 border-sky-200/60' },
  fact: { label: '事实', icon: Lightbulb, badgeClass: 'bg-amber-50 text-amber-600 border-amber-200/60' },
  game: { label: '游戏', icon: Gamepad2, badgeClass: 'bg-violet-50 text-violet-600 border-violet-200/60' },
}

/** F20261013csv3 T2：file/fact 卡折叠态摘要行最大字符数——content 首行摘要 */
const FOLDED_SNIPPET_MAX = 120

/** content 首行摘要：取首个非空行，截断至 FOLDED_SNIPPET_MAX（T2——file 卡折叠态信息增量） */
function firstLineSnippet(content: string | null): string | null {
  if (!content) return null
  const firstLine = content.split('\n').map(l => l.trim()).find(l => l.length > 0)
  if (!firstLine) return null
  return firstLine.length > FOLDED_SNIPPET_MAX
    ? firstLine.slice(0, FOLDED_SNIPPET_MAX - 1) + '…'
    : firstLine
}

export function ArtifactCard({ resource, pinned, onTogglePin }: {
  resource: LocalLinkedResource
  pinned: boolean
  onTogglePin: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  /** F20261021gmbe：game 放大态（modal 全屏）——与 expanded 独立（放大必先展开） */
  const [enlarged, setEnlarged] = useState(false)
  const badge = TYPE_BADGES[resource.type] ?? {
    label: resource.type,
    icon: FileText,
    badgeClass: 'bg-stone-100 text-stone-500 border-stone-200/60',
  }
  const Icon = badge.icon

  // F20261021gmbe：game 型——白名单校验（同源 ^/mahjong/[\w-]+$ 全匹配），不通过降级摘要卡
  const isGame = resource.type === 'game'
  const gamePath = isGame ? resolveGameEmbedPath(resource.url) : null
  /** 展开态：game 超出 max-w-md，撑满中间栏（牌桌 ≥940px 断点直接可玩） */
  const gameExpanded = isGame && gamePath !== null && expanded

  const body = (() => {
    if (resource.type === 'fact') {
      // fact 全文 ≤500 字（FACT_CONTENT_MAX_LENGTH），卡内直出——这就是「结论卡」的信息增量
      return <p className="text-sm text-stone-700 leading-relaxed whitespace-pre-wrap break-words">{resource.content}</p>
    }
    if (gamePath) {
      // F20261021gmbe：game 卡折叠态（与现摘要卡视觉一致）——房间号 + 展开玩入口；
      // 展开态 body 让位面板（不重复显示 url 文本）
      if (expanded) return null
      const roomId = gamePath.split('/').pop()
      return (
        <div className="flex items-center gap-2">
          <p className="text-xs text-stone-400 truncate">房间 {roomId}</p>
          <button
            onClick={() => setExpanded(true)}
            className="text-xs text-otter-500 hover:underline flex-shrink-0"
            data-testid="game-expand"
          >
            展开玩
          </button>
        </div>
      )
    }
    // T2：file 卡折叠态摘要行（content 首行摘要）——不再只有标题+URL
    const snippet = firstLineSnippet(resource.content)
    if (snippet) {
      return <p className="text-sm text-stone-600 leading-relaxed">{snippet}</p>
    }
    if (resource.url) {
      return <p className="text-xs text-stone-400 truncate">{resource.url}</p>
    }
    return null
  })()

  // T2：PR 卡 unfurl join 投影（后端 LinkedResourceDTO.unfurl——diff stat + 状态徽章数据源）
  const unfurl = resource.unfurl

  return (
    <div
      data-artifact-id={resource.id}
      className={`my-2 rounded-xl border px-3.5 py-3 transition ${
        gameExpanded ? 'w-full' : 'max-w-md'
      } ${
        pinned
          ? 'border-otter-300/60 bg-otter-50/50'
          : 'border-stone-200/80 bg-stone-50/70'
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold border ${badge.badgeClass}`}>
          <Icon className="w-3 h-3" />
          {badge.label}
        </span>
        {/* T2：PR 状态徽章（unfurl join 投影 state 字段——检视发现 1：曾退用
            title.includes 猜状态，closed/draft 误显「开放中」；与 UnfurlCard 徽章同口径） */}
        {resource.type === 'pr' && unfurl?.source === 'github-api' && unfurl.state && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${
            unfurl.state === 'MERGED' ? 'bg-lavender-400/20 text-lavender-500'
            : unfurl.state === 'OPEN' ? 'bg-teal-400/20 text-teal-600'
            : unfurl.state === 'CLOSED' ? 'bg-stone-300/40 text-stone-500'
            : 'bg-amber-400/20 text-amber-600'
          }`}>
            {unfurl.state === 'MERGED' ? '已合并'
              : unfurl.state === 'OPEN' ? '开放中'
              : unfurl.state === 'CLOSED' ? '已关闭'
              : '草稿'}
          </span>
        )}
        <span className="text-sm font-medium text-stone-700 truncate flex-1">{resource.title}</span>
        <button
          onClick={() => onTogglePin(resource.id)}
          className="p-1 rounded hover:bg-stone-200/70 transition text-stone-400 hover:text-stone-600 flex-shrink-0"
          title={pinned ? '取消钉住' : '钉住（留在视野中）'}
        >
          {pinned ? <Pin className="w-3.5 h-3.5 text-otter-500" /> : <PinOff className="w-3.5 h-3.5" />}
        </button>
      </div>
      {body}
      {/* F20261021gmbe：game 展开态——宿主内嵌游戏面板（白名单内同源 iframe；收起即卸载断 SSE；
          放大态时内联位让位 modal（单实例，避免双 iframe 双 SSE）） */}
      {gameExpanded && !enlarged && (
        <div className="mt-2">
          <GameEmbedPanel url={resource.url} title={resource.title} />
        </div>
      )}
      {/* T2：PR 卡 diff stat（unfurl join 投影——additions/deletions 仅 github-api PR 记录携带） */}
      {resource.type === 'pr' && unfurl?.additions != null && unfurl?.deletions != null && (
        <p className="text-[11px] mt-1">
          <span className="text-teal-600">+{unfurl.additions}</span>
          <span className="text-stone-400"> / </span>
          <span className="text-red-400">−{unfurl.deletions}</span>
          <span className="text-stone-400"> · 来自 gh 结构化取数</span>
        </p>
      )}
      {/* T2：join 落空（历史 PR/未抓取）——显式「未抓取」态，不静默缺失 */}
      {resource.type === 'pr' && resource.url && !unfurl && (
        <p className="text-[11px] text-stone-400 mt-1">未抓取（将自动补抓）</p>
      )}
      {expanded && resource.type !== 'fact' && resource.type !== 'game' && resource.content && (
        <p className="mt-2 text-sm text-stone-600 leading-relaxed whitespace-pre-wrap break-words border-t border-stone-200/60 pt-2">
          {resource.content}
        </p>
      )}
      <div className="flex items-center gap-2.5 mt-2 text-[11px] text-stone-400">
        {resource.url && (
          <a
            href={resource.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-otter-500 hover:underline"
          >
            <ExternalLink className="w-3 h-3" />
            打开
          </a>
        )}
        {isGame && gamePath && expanded && (
          <>
            <button
              onClick={() => { setExpanded(false); setEnlarged(false) }}
              className="text-stone-400 hover:text-stone-600"
              data-testid="game-collapse"
            >
              收起
            </button>
            <button
              onClick={() => setEnlarged(true)}
              className="inline-flex items-center gap-0.5 text-otter-500 hover:underline"
              data-testid="game-enlarge"
            >
              <Maximize2 className="w-3 h-3" />
              放大
            </button>
          </>
        )}
        {!expanded && resource.type !== 'fact' && resource.content && resource.content.length > FOLDED_SNIPPET_MAX && (
          <button
            onClick={() => setExpanded(true)}
            className="text-stone-400 hover:text-stone-600"
          >
            展开全文
          </button>
        )}
        {resource.auto && <span>自动登记</span>}
      </div>
      {/* F20261021gmbe：放大 modal（90vw，牌桌完整体验）——收起/关闭即卸载 */}
      {gameExpanded && enlarged && (
        <GameEnlargeModal
          url={resource.url}
          title={resource.title}
          onClose={() => setEnlarged(false)}
        />
      )}
    </div>
  )
}

/** F20261021gmbe：放大态 modal——复用 Modal（焦点管理/Escape/栈）；宽度 90vw，
 *  iframe 高度扣掉 header/内边距（modal 内容区上限 calc(80vh-120px)）。
 *  键盘局限（检视发现 1 反驳注明）：iframe 一且获得焦点（打牌/聊天输入是必然操作），
 *  键盘事件派发进 iframe 内部 document 不冒泡父页——Escape/Tab trap 在此时失效，
 *  这是 iframe 嵌入的浏览器级行为（非本实现缺陷）。鼠标关闭始终可用（X 按钮 + scrim
 *  点击，Modal.tsx:115/130）；键盘在 iframe 内属游戏操作域。向 iframe 转发 Escape
 *  需 contentWindow 挂监听（同源可行但有导航重挂/泄漏面），收益不值复杂度，不修。 */
function GameEnlargeModal({ url, title, onClose }: {
  url: string | null
  title: string
  onClose: () => void
}) {
  return (
    <Modal isOpen onClose={onClose} title={title} width="90vw">
      <div className="-m-5" style={{ width: 'calc(100% + 2.5rem)' }}>
        <GameEmbedPanel url={url} title={title} heightClass="h-[calc(80vh-170px)]" />
      </div>
    </Modal>
  )
}
