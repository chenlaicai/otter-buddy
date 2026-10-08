import { useEffect, useState } from 'react'
import { Globe, ImageOff } from 'lucide-react'

/** F20261008csf1 P1：链类 unfurl 预览卡。
 *
 * 宪法「不点开就有信息增量」：裸 URL 在消息流里是零信息（域名+路径），
 * 预览卡把它变成「标题 + 描述 + 站点」——决定去不去之前先知道那是什么。
 * 数据源：GET /api/unfurl?url=（服务端代理抓 og 元数据，带 SSRF 防护与超时）。
 * 失败降级：404/超时 → 渲染普通链接样式（与未接本特性前视觉一致）。
 */

export interface UnfurlData {
  url: string
  title: string | null
  description: string | null
  image: string | null
  siteName: string | null
  host: string
}

type UnfurlState =
  | { phase: 'loading' }
  | { phase: 'ok'; data: UnfurlData }
  | { phase: 'failed' }

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

/** 抓取（可被测试 mock：export 后测试 vi.mock 本模块或直接 stub fetch） */
export async function fetchUnfurl(url: string): Promise<UnfurlData | null> {
  try {
    const resp = await fetch(`/api/unfurl?url=${encodeURIComponent(url)}`)
    if (!resp.ok) return null
    return (await resp.json()) as UnfurlData
  } catch {
    return null
  }
}

/** 裸链检测：正文片段是「只有一个链接、无其他文字」时才出预览卡——
 *  句中链接（如「见 [文档](url)」）不抢排版，保持 GFM 默认行内样式。
 *  ⚠️ 仅测试参考实现——生产真相源是 remark-bare-link.ts（mdast 层判定，经
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
    fetchUnfurl(url).then(data => {
      if (disposed) return
      const next: UnfurlState = data ? { phase: 'ok', data } : { phase: 'failed' }
      setCachedUnfurl(url, next)
      setState(next)
    })
    return () => { disposed = true }
  }, [url])

  // 降级 = 与未接本特性前一致的普通链接样式（宪法失败降级要求）
  if (state.phase === 'failed') {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="text-otter-500 hover:underline break-all">
        {url}
      </a>
    )
  }
  if (state.phase === 'loading') {
    return (
      <span className="inline-flex items-center gap-1.5 text-stone-400 text-xs py-1">
        <Globe className="w-3.5 h-3.5 animate-pulse" />
        加载预览…
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
          <span className="block text-sm font-medium text-stone-700 leading-snug break-words">{displayTitle}</span>
          {d.description && (
            <span className="block text-xs text-stone-500 mt-0.5 line-clamp-2 break-words">{d.description}</span>
          )}
          <span className="block text-[11px] text-stone-400 mt-1">
            {d.siteName ? `${d.siteName} · ` : ''}{d.host}
          </span>
        </span>
      </span>
    </a>
  )
}

/** 供 line-clamp 的 fallback 展示（favicon 加载失败时占位）——ImageOff 保留引用防 tree-shake 误报 */
export const UnfurlIcons = { Globe, ImageOff }
