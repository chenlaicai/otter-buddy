import { useEffect, useState } from 'react'
import { ExternalLink, RefreshCw, Loader2 } from 'lucide-react'

/** F20261021gmbe E1：宿主内嵌游戏面板。
 *
 * 游戏型产物卡的展开态渲染通道：宿主直渲 iframe（非 html-card 沙箱——沙箱 CSP
 * connect-src 'none' 断 SSE/fetch，麻将 EventSource 不可行，方案 E1 定稿）。
 *
 * 安全边界（两层，缺一不可）：
 *  1. 同源白名单——resolveGameEmbedPath 全匹配 ^/mahjong/[\w-]+$（[\w-] 不含 / 和 .，
 *     路径穿越变体被 URL 规范化后落出白名单）；外部 URL / 绝对 URL / 协议相对 URL
 *     一律拒绝，降级「摘要卡+新窗口」（E5 底线：外部站点永不内嵌）
 *  2. iframe sandbox="allow-scripts allow-same-origin"——同源保留（SSE/fetch/相对 URL
 *     全通，麻将页零功能损失），默认拦 top-level navigation（iframe 不能把对话页
 *     parent.location 跳去钓鱼站）、弹窗、表单。诚实标注边界：allow-same-origin 下
 *     恶意脚本仍可访问 parent DOM（防意外不防恶意），白名单把「恶意」面收窄到
 *     本应用自己路由，转义纪律由麻将页 esc（app.js）承担。
 *
 * 生命周期：收起即卸载（ArtifactCard 条件渲染 → iframe 移除 → SSE 断），
 * 折叠态不挂 iframe（E4——省连接，时间轴扫读性优先）。 */

/** F20261021gmbe：游戏内嵌白名单模式——仅本应用麻将牌局路由。
 *  后续新形态接入=往白名单数组加本应用路由前缀（方案「后续形态接入契约」1）；
 *  未接入白名单的资源型/URL 一律降级摘要卡，内嵌是显式开通的特权。 */
const GAME_EMBED_PATTERNS: RegExp[] = [/^\/mahjong\/[\w-]+$/]

/** 协议（scheme）前缀：http:、javascript:、data: 等——绝对 URL/危险协议一律拒绝 */
const SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z\d+\-.]*:/
/** 反斜杠：浏览器按 / 规范化，先于解析显式拒绝（反斜杠 mahjong 变体不给规范化机会） */
const BACKSLASH = /\\/

/** URL 规范化会剥掉控制字符/空白再解析——解析前显式拒绝，防规范化掩护注入。
 *  用 charCode 循环而非正则字面量（控制字符正则会把源文件写进不可见字符）。 */
function hasControlChar(url: string): boolean {
  for (let i = 0; i < url.length; i++) {
    if (url.charCodeAt(i) < 0x21) return true
  }
  return false
}

/**
 * 同源白名单校验（F20261021gmbe 安全边界第 1 层）。
 *
 * 返回可直接作 iframe src 的同源 pathname；不通过白名单返回 null（调用方降级
 * 「摘要卡+新窗口」，不内嵌）。校验链：
 *  拒绝对 URL（scheme 前缀/协议相对 //）→ 拒反斜杠/控制字符 → new URL 解析
 *  （规范化 pathname：/mahjong/../api → /api、%2e%2e → 出白名单）→ origin 复核
 *  （必须同源）→ pathname 全匹配白名单（非前缀匹配——/mahjong/a/b 被拒）。
 */
export function resolveGameEmbedPath(url: string | null | undefined): string | null {
  if (!url) return null
  if (SCHEME_PREFIX.test(url) || url.startsWith('//')) return null
  if (BACKSLASH.test(url) || hasControlChar(url)) return null
  let parsed: URL
  try {
    parsed = new URL(url, window.location.origin)
  } catch {
    return null
  }
  if (parsed.origin !== window.location.origin) return null
  return GAME_EMBED_PATTERNS.some(p => p.test(parsed.pathname)) ? parsed.pathname : null
}

/** 加载超时阈值（ms）——loading 态超此限无 onLoad 即判错误（超时探针） */
export const GAME_EMBED_LOAD_TIMEOUT_MS = 15000

export function GameEmbedPanel({ url, title, heightClass = 'h-[600px]' }: {
  url: string | null
  title: string
  /** inline 展开态 h-[600px]（中间栏 ≥940px 直接可玩）；放大 modal 态 h-[85vh] */
  heightClass?: string
}) {
  const embedPath = resolveGameEmbedPath(url)
  /** 加载态：jsdom/慢网下 onLoad 前的遮罩；error：加载超时（React 19 对 iframe 不接
   *  onError（react-dom-client：iframe case 只挂 load 非委托监听，error 仅 img/source/
   *  media），浏览器同源 iframe 加载失败也不冒 error 事件——超时探针是唯一可靠错误信号） */
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  /** 重试计数——换 key 强制重建 iframe（重新发起加载） */
  const [attempt, setAttempt] = useState(0)

  /** 加载超时探针：loading 态 15s 无 onLoad → error（带重试/新窗口出路） */
  useEffect(() => {
    if (phase !== 'loading') return
    const t = setTimeout(() => setPhase('error'), GAME_EMBED_LOAD_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [phase, attempt])

  /** 组件级守卫兜底：调用方（ArtifactCard）已做校验不挂载，此处防未来直挂误用 */
  if (!embedPath) {
    return (
      <div data-testid="game-embed-blocked" className="rounded-lg border border-amber-200/60 bg-amber-50/60 px-3 py-2 text-xs text-amber-700">
        非白名单地址，不内嵌。
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 ml-1 underline">
            <ExternalLink className="w-3 h-3" />
            新窗口打开
          </a>
        )}
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div data-testid="game-embed-error" className={`relative rounded-lg border border-stone-200/80 bg-stone-100/60 flex flex-col items-center justify-center gap-2 ${heightClass}`}>
        <p className="text-sm text-stone-500">游戏面板加载失败</p>
        <div className="flex items-center gap-3 text-xs">
          <button
            onClick={() => { setPhase('loading'); setAttempt(a => a + 1) }}
            className="inline-flex items-center gap-0.5 text-otter-500 hover:underline"
          >
            <RefreshCw className="w-3 h-3" />
            重试
          </button>
          <a href={embedPath} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-otter-500 hover:underline">
            <ExternalLink className="w-3 h-3" />
            新窗口打开
          </a>
        </div>
      </div>
    )
  }

  return (
    <div data-testid="game-embed-panel" className="relative rounded-lg overflow-hidden border border-stone-200/80 bg-stone-900/5">
      <iframe
        key={attempt}
        src={embedPath}
        title={title}
        sandbox="allow-scripts allow-same-origin"
        onLoad={() => setPhase('ready')}
        className={`w-full border-0 block ${heightClass}`}
      />
      {phase === 'loading' && (
        <div data-testid="game-embed-loading" className="absolute inset-0 flex items-center justify-center bg-stone-50/80">
          <span className="inline-flex items-center gap-1.5 text-xs text-stone-400">
            <Loader2 className="w-4 h-4 animate-spin" />
            牌桌加载中…
          </span>
        </div>
      )}
    </div>
  )
}
