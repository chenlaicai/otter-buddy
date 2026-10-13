import { useEffect, useState } from 'react'
import { Globe, ImageOff } from 'lucide-react'

/** F20261008csf1 P1 + F20261013csv3 T1：链类 unfurl 预览卡（数据先行架构）。
 *
 * 宪法「不点开就有信息增量」：裸 URL 在消息流里是零信息（域名+路径），
 * 预览卡把它变成「标题 + 描述 + 站点」——决定去不去之前先知道那是什么。
 * 数据源：GET /api/unfurl?url=（读 unfurl_cache 表，不再实时抓取——P1 数据先行）。
 *
 * F20261013csv3 三态（mimo S1——预抓取未完成是常态）：
 * - ok：缓存命中 → 渲染完整预览卡
 * - pending：记录不存在/后台抓取中 → 骨架卡轮询（500ms×12，~6s 窗口），
 *   下一次轮询命中已落库的结果（发送时预抓取钩子通常已提前备好数据）
 * - failed：显式失败卡（source='failed'，7 天窗口）——不再静默退纯文本：
 *   「预览抓取失败」+ 原链可点，失败是显式状态（P1 原则：渲染不得静默缺失）
 *
 * 兼容：404（API 错误）仍走 failed 态；旧 pending 卡轮询窗口耗尽也落 failed
 * （带「重试」按钮触发后台补抓）。og 永久缓存；github-api 24h SWR（陈旧值带徽记）。
 */

export interface UnfurlData {
  url: string
  title: string | null
  description: string | null
  image: string | null
  siteName: string | null
  host: string
  /** F20261013csv3：github-api 记录的 PR/issue 状态（open/merged/closed）——状态徽章 */
  state?: string | null
  /** F20261013csv3：github-api PR 记录的 diff stat（+additions/−deletions） */
  additions?: number | null
  deletions?: number | null
  /** F20261013csv3：SWR 陈旧徽记（github-api 记录超 24h 时由后端透传） */
  stale?: boolean
}

/** 三态响应（与后端 UnfurlResponse 对齐） */
type UnfurlResponse =
  | { status: 'ok'; data: UnfurlData }
  | { status: 'failed'; url: string; error: string; host: string }
  | { status: 'pending'; url: string }

export type UnfurlState =
  | { phase: 'loading' } // 首次请求进行中
  | { phase: 'pending'; attempts: number } // 已确认 pending（后台抓取中），轮询窗口内
  | { phase: 'ok'; data: UnfurlData }
  | { phase: 'failed'; error: string; host: string }

/** 结果会话级缓存：同一 URL 在同一会话内只抓一次（StrictMode 双挂载/重渲染保护） */
const cache = new Map<string, UnfurlState>()

export function unfurlCacheKey(url: string): string {
  return url
}

export function getCachedUnfurl(url: string): UnfurlState | undefined {
  return cache.get(unfurlCacheKey(url))
}

export function setCachedUnfurl(url: string, state: UnfurlState): void {
  cache.set(unfurlCacheKey(url), state)
}

/** 轮询预算：500ms × 12 ≈ 6s（发送时预抓取通常 < 1s 完成，6s 是宽松上限） */
const POLL_INTERVAL_MS = 500
const POLL_MAX_ATTEMPTS = 12

/** 抓取（可被测试 mock：export 后测试 vi.mock 本模块或直接 stub fetch） */
export async function fetchUnfurl(url: string): Promise<UnfurlResponse | null> {
  try {
    const resp = await fetch(`/api/unfurl?url=${encodeURIComponent(url)}`)
    if (!resp.ok) return null
    return (await resp.json()) as UnfurlResponse
  } catch {
    return null
  }
}

/** 裸链检测：正文片段是「只有一个链接、无其他文字」时才出预览卡——
 *  句中链接（如「见 [文档](url)」）不抢排版，保持 GFM 默认行内样式。
 *  ⚠️ 仅测试参考实现——生产真相源是 remark-bare-url.ts（mdast 层判定，经
 *  hProperties 通道传 dataBareUrl）。本函数不进组件树（全仓 grep 仅测试引用），
 *  留着供单测验证裸链口径与插件实现一致性；改判定规则时两处必须同步 */
export function isBareUrlText(text: string): string | null {
  const t = text.trim()
  // Markdown 链接形态 [label](url) 不出卡（有作者给的锚文本）
  if (/^\[[^\]]*\]\([^)]*\)$/.test(t)) return null
  const m = /^(https?:\/\/[^\s<>"']+)$/.exec(t)
  if (!m) return null
  try {
    const u = new URL(m[1])
    // 至少要有 host——纯协议串不算
    return u.hostname ? m[1] : null
  } catch {
    return null
  }
}

export function UnfurlCard({ url }: { url: string }) {
  const [state, setState] = useState<UnfurlState>(() => getCachedUnfurl(url) ?? { phase: 'loading' })

  useEffect(() => {
    const cached = getCachedUnfurl(url)
    if (cached) {
      setState(cached)
      return
    }
    let disposed = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      const resp = await fetchUnfurl(url)
      if (disposed) return
      if (!resp) {
        // 网络级失败（API 不可达）：按 failed 处理（兼容旧契约 404 语义）
        const next: UnfurlState = { phase: 'failed', error: '预览服务不可达', host: safeHost(url) }
        setCachedUnfurl(url, next)
        setState(next)
        return
      }
      if (resp.status === 'ok') {
        const next: UnfurlState = { phase: 'ok', data: resp.data }
        setCachedUnfurl(url, next)
        setState(next)
        return
      }
      if (resp.status === 'failed') {
        const next: UnfurlState = { phase: 'failed', error: resp.error, host: resp.host }
        setCachedUnfurl(url, next)
        setState(next)
        return
      }
      // pending：后台抓取中，继续轮询（500ms×12 窗口）
      attempts += 1
      if (attempts >= POLL_MAX_ATTEMPTS) {
        const next: UnfurlState = { phase: 'failed', error: '预览抓取超时', host: safeHost(url) }
        setCachedUnfurl(url, next)
        setState(next)
        return
      }
      const next: UnfurlState = { phase: 'pending', attempts }
      setState(next)
      timer = setTimeout(() => void poll(), POLL_INTERVAL_MS)
    }

    void poll()
    return () => { disposed = true; if (timer) clearTimeout(timer) }
  }, [url])

  // F20261013csv3：显式失败卡（不再静默退纯文本——P1 原则：失败是显式状态）
  if (state.phase === 'failed') {
    return (
      <span className="block my-2 rounded-xl border border-stone-200/60 bg-stone-50/60 overflow-hidden max-w-md">
        <span className="flex items-center gap-2.5 p-3">
          <ImageOff className="w-4 h-4 text-stone-400 flex-shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium text-stone-500">预览抓取失败</span>
            <span className="block text-[11px] text-stone-400 mt-0.5 truncate">{state.error}</span>
          </span>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-otter-500 hover:underline flex-shrink-0 break-all"
          >
            {state.host || url}
          </a>
        </span>
      </span>
    )
  }

  // 骨架轮询态：显示结构占位（标题/描述/站点三行微光骨架），感知「正在准备数据」
  if (state.phase === 'loading' || state.phase === 'pending') {
    return (
      <span
        className="block my-2 rounded-xl border border-stone-200/60 bg-white/40 overflow-hidden max-w-md"
        aria-busy="true"
        aria-label="预览加载中"
      >
        <span className="flex items-start gap-2.5 p-3">
          <span className="w-[18px] h-[18px] rounded-sm bg-stone-200/70 animate-pulse flex-shrink-0 mt-0.5" />
          <span className="min-w-0 flex-1 space-y-1.5">
            <span className="block h-3.5 w-3/4 rounded bg-stone-200/70 animate-pulse" />
            <span className="block h-3 w-1/2 rounded bg-stone-200/50 animate-pulse" />
            <span className="block h-2.5 w-1/4 rounded bg-stone-200/40 animate-pulse" />
          </span>
        </span>
      </span>
    )
  }

  const d = state.data
  const displayTitle = d.title ?? d.host
  return (
    <a
      href={d.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block my-2 rounded-xl border border-stone-200/80 bg-white/70 hover:bg-white/90 transition overflow-hidden max-w-md"
    >
      {d.image ? (
        <img
          src={d.image}
          alt=""
          loading="lazy"
          className="w-full max-h-36 object-cover"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      ) : null}
      <span className="flex items-start gap-2.5 p-3">
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(d.host)}&sz=64`}
          alt=""
          width={18}
          height={18}
          className="w-[18px] h-[18px] rounded-sm mt-0.5 flex-shrink-0"
          onError={(e) => {
            // favicon 服务失败时换站内兜底图标，不出现破图
            const img = e.target as HTMLImageElement
            if (!img.dataset.fallback) {
              img.dataset.fallback = '1'
              img.src = ''
              img.style.display = 'none'
            }
          }}
        />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 flex-wrap">
            <span className="block text-sm font-medium text-stone-700 leading-snug break-words">{displayTitle}</span>
            {/* github-api 状态徽章：merged=紫 / open=绿 / closed=灰 / draft=琥珀 */}
            {d.state && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${
                d.state === 'merged' || d.state === 'MERGED' ? 'bg-lavender-400/20 text-lavender-500'
                : d.state === 'open' || d.state === 'OPEN' ? 'bg-teal-400/20 text-teal-600'
                : 'bg-stone-300/40 text-stone-500'
              }`}>
                {d.state === 'merged' || d.state === 'MERGED' ? '已合并'
                  : d.state === 'open' || d.state === 'OPEN' ? '开放中'
                  : d.state === 'draft' ? '草稿'
                  : d.state}
              </span>
            )}
          </span>
          {/* github-api PR diff stat（+additions/−deletions） */}
          {d.additions != null && d.deletions != null && (
            <span className="block text-[11px] mt-0.5">
              <span className="text-teal-600">+{d.additions}</span>
              <span className="text-stone-400"> / </span>
              <span className="text-red-400">−{d.deletions}</span>
            </span>
          )}
          {d.description && (
            <span className="block text-xs text-stone-500 mt-0.5 line-clamp-2 break-words">{d.description}</span>
          )}
          <span className="block text-[11px] text-stone-400 mt-1">
            {d.siteName ? `${d.siteName} · ` : ''}{d.host}
            {d.stale ? ' · 数据可能过时' : ''}
          </span>
        </span>
      </span>
    </a>
  )
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** 供 line-clamp 的 fallback 展示（favicon 加载失败时占位）——Globe/ImageOff 保留引用防 tree-shake 误报 */
export const UnfurlIcons = { Globe, ImageOff }
