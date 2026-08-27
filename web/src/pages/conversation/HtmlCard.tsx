import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Hash, ShieldCheck, AlertTriangle } from 'lucide-react'
import { CARD_MAX_BYTES, CARD_MAX_PER_MESSAGE, byteLength } from '../../lib/html-card'
import { registerCard, unregisterCard } from '../../lib/card-registry'
import { buildCardBridgeScript } from '../../lib/card-bridge'

/** srcdoc 注入的设计 token（与 globals.css 水獭色组一致，卡片作者的样式变量契约） */
const CARD_TOKEN_CSS = `:root {
  --otter-50:#FAF6F0; --otter-100:#F0E8DC; --otter-200:#E0D0BC; --otter-300:#C9AC8E;
  --otter-400:#A88260; --otter-500:#8B6F47; --otter-600:#6B5638; --otter-700:#52402C;
  --otter-800:#3A2E1F; --otter-900:#2A2014;
  --teal-300:#7BC5C5; --teal-400:#4A9B9B; --teal-500:#3A8B8B; --teal-600:#2A7B7B;
  --caramel-400:#D9A57B; --caramel-500:#C9956B;
  --lavender-400:#9B8AC8; --lavender-500:#8B7AB8;
  --paper:#FFFDF9; --ink:#3A2E1F; --ink-3:#5F5447; --line:rgba(42,32,20,0.14);
}
body { margin:0; padding:12px; background:var(--paper); color:var(--ink);
  font:14px/1.6 -apple-system, "PingFang SC", "Segoe UI", sans-serif; }`

/** CSP：default-src 'none' 断外网；form-action 'none' 堵表单外泄；脚本仅限内联（桥 + AI 脚本同上下文） */
const CARD_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'"

/** 组装 iframe srcdoc：CSP meta + 设计 token + 桥脚本（仅可交互卡片）+ AI HTML */
function buildCardSrcdoc(html: string, cardId: string, interactive: boolean): string {
  const bridge = interactive ? `<script>${buildCardBridgeScript(cardId)}</script>` : ''
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CARD_CSP}"><style>${CARD_TOKEN_CSS}</style></head><body>${html}${bridge}</body></html>`
}

export interface HtmlCardProps {
  /** {messageId}:{fenceIndex} */
  cardId: string
  fenceIndex: number
  title: string | null
  /** 围栏内 AI 提供的 HTML 原文 */
  code: string
  /** otter 卡片可交互（sandbox allow-scripts + 注入桥）；user 卡片静态（无脚本无桥） */
  interactive: boolean
  /** 卡片所在消息的 senderId（registry 登记，回执显式路由用） */
  authorId: string
}

type CardView = 'collapsed' | 'expanded' | 'source' | 'invalid'

function HtmlCardInner({ cardId, fenceIndex, title, code, interactive, authorId }: HtmlCardProps) {
  const [view, setView] = useState<CardView>('collapsed')
  const [height, setHeight] = useState(240)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const loadCountRef = useRef(0)
  const oversize = byteLength(code) > CARD_MAX_BYTES

  const srcdoc = useMemo(
    () => (view === 'expanded' ? buildCardSrcdoc(code, cardId, interactive) : ''),
    [view, code, cardId, interactive],
  )

  /** 展开时向 registry 登记 contentWindow ↔ cardId（source 白名单 + 高度回写 + 作者路由）。
   *  进入 expanded 即重置 loadCount（user 卡片无桥也要重置：collapse→re-expand 会重挂载 iframe，
   *  不重置则二次 load 计数沿用旧值，被误判为导航逃逸而降级 invalid） */
  useEffect(() => {
    if (view !== 'expanded') return
    loadCountRef.current = 0
    if (!interactive) return
    const win = iframeRef.current?.contentWindow
    if (!win) return
    registerCard({ cardId, authorId, contentWindow: win, setHeight })
    return () => unregisterCard(cardId, win)
  }, [view, interactive, cardId, authorId])

  /** 导航逃逸事后检测：首次 load 是 srcdoc 正常挂载；二次 load = location/meta refresh 导航，销毁降级 */
  const handleLoad = () => {
    loadCountRef.current += 1
    if (loadCountRef.current > 1) setView('invalid')
  }

  const btnCls = 'px-2 py-0.5 rounded-lg text-[11px] text-stone-500 hover:bg-white/60 transition'

  /** 预算兜底：第 3 张起降级为源码块 */
  if (fenceIndex >= CARD_MAX_PER_MESSAGE) {
    return (
      <div className="my-2 rounded-xl border border-stone-200/60 bg-white/40 overflow-hidden">
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-stone-400">
          <AlertTriangle className="w-3 h-3" />
          超出单消息卡片上限（{CARD_MAX_PER_MESSAGE} 张），已降级为源码
        </div>
        <pre className="px-3 pb-3 text-[11px] text-stone-500 whitespace-pre-wrap break-all max-h-[var(--compact-scroll-max-h)] overflow-y-auto">{code}</pre>
      </div>
    )
  }

  return (
    <div className="my-2 rounded-xl border border-stone-200/60 bg-white/40 overflow-hidden" data-card-id={cardId}>
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-stone-600">
        <Hash className="w-3 h-3 text-stone-400 flex-shrink-0" />
        <span className="font-medium truncate flex-1">{title || '未命名卡片'}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-otter-400/15 text-otter-600 flex-shrink-0">HTML 卡片</span>
        {oversize && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-stalled text-amber-700 flex-shrink-0" title={`卡片超出 ${CARD_MAX_BYTES / 1024}KB 体积预算`}>
            超 {CARD_MAX_BYTES / 1024}KB
          </span>
        )}
        {view === 'invalid' ? (
          <>
            <span className="text-[11px] text-red-400 flex-shrink-0">已失效（检测到导航）</span>
            <button className={btnCls} onClick={() => setView('source')}>看源码</button>
          </>
        ) : view === 'expanded' ? (
          <>
            <button className={btnCls} onClick={() => setView('collapsed')}>收起</button>
            <button className={btnCls} onClick={() => setView('source')}>看源码</button>
          </>
        ) : view === 'source' ? (
          <button className={btnCls} onClick={() => setView('collapsed')}>返回</button>
        ) : (
          <>
            <button className={btnCls} onClick={() => setView('expanded')}>展开渲染</button>
            <button className={btnCls} onClick={() => setView('source')}>看源码</button>
          </>
        )}
      </div>
      {view === 'expanded' && (
        <>
          <iframe
            ref={iframeRef}
            /* 绝不加 allow-same-origin：保持 opaque origin 隔离 */
            sandbox={interactive ? 'allow-scripts' : ''}
            srcDoc={srcdoc}
            onLoad={handleLoad}
            title={title || 'HTML 卡片'}
            className="w-full border-0 block bg-white"
            style={{ height }}
          />
          <div className="flex items-center gap-1 px-3 py-1 text-[10px] text-stone-400">
            <ShieldCheck className="w-3 h-3" />
            沙箱隔离 · 内容不可信
          </div>
        </>
      )}
      {view === 'source' && (
        <pre className="px-3 pb-3 text-[11px] text-stone-500 whitespace-pre-wrap break-all max-h-[var(--list-scroll-max-h)] overflow-y-auto">{code}</pre>
      )}
    </div>
  )
}

/** memo + 稳定 key（messageId:fenceIndex）：流式期间避免已展开卡片重挂载、表单状态丢失 */
export const HtmlCard = memo(HtmlCardInner)
