import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { MessageCircle, Search, Package, Settings, Activity, ClipboardList, type LucideIcon } from 'lucide-react'
import { NAV_ROUTES } from '@contract/web/pages'

/** icon 映射（路由 path → icon 组件）。新增路由忘配 icon 只视觉降级不编译失败 */
const ICONS: Record<string, LucideIcon> = {
  '/conversation': MessageCircle,
  '/memory': Search,
  '/skills': Package,
  '/im': MessageCircle,
  '/health': Activity,
  '/activity': ClipboardList,
  '/settings': Settings,
}

type SelectionBox = { left: number; width: number }

/** SPA TopBar —— 独立系统图标 + 居中 Liquid Glass 主导航，由 AppLayout 渲染一次 */
export function TopBar() {
  const location = useLocation()
  const contentRef = useRef<HTMLDivElement>(null)
  const selectionRef = useRef<HTMLSpanElement>(null)
  const selectionBoxRef = useRef<SelectionBox>({ left: 0, width: 0 })
  const [selectionBox, setSelectionBox] = useState<SelectionBox>({ left: 0, width: 0 })

  /** 判断当前路由是否激活：精确匹配或前缀匹配（/conversation 匹配 /conversation/xxx） */
  function isActive(path: string): boolean {
    if (path === '/conversation') {
      return location.pathname === '/conversation'
        || location.pathname === '/'
        || location.pathname.startsWith('/conversation/')
    }
    return location.pathname === path
  }

  /** 单个选中透镜跟随路由移动；中段沿移动方向拉长，模拟钉钉的弹性玻璃切换。 */
  function measureSelection(animate: boolean) {
    const content = contentRef.current
    const selection = selectionRef.current
    const animations = typeof selection?.getAnimations === 'function' ? selection.getAnimations() : []
    const contentRect = content?.getBoundingClientRect()
    const hasActiveAnimation = animations.some(animation => animation.playState === 'running')
    // 连点时从屏幕上的真实中间帧接续，不能先跳回上一次路由的目标框。
    const previous = animate && hasActiveAnimation && content && contentRect && selection
      ? (() => {
          const rect = selection.getBoundingClientRect()
          return { left: rect.left - contentRect.left + content.scrollLeft, width: rect.width }
        })()
      : selectionBoxRef.current
    // 新路由、resize、无激活项及动态减少动态效果都会在这里中止旧时间轴。
    animations.forEach(animation => animation.cancel())

    const activeLink = content?.querySelector<HTMLElement>('[data-active="true"]')
    if (!content || !contentRect || !activeLink) {
      const empty = { left: 0, width: 0 }
      selectionBoxRef.current = empty
      setSelectionBox(empty)
      return
    }
    const linkRect = activeLink.getBoundingClientRect()
    const next = {
      left: linkRect.left - contentRect.left + content.scrollLeft,
      width: linkRect.width,
    }
    selectionBoxRef.current = next
    setSelectionBox(next)

    const reducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!animate || !selection || previous.width === 0 || reducedMotion || typeof selection.animate !== 'function') return
    const distance = next.left - previous.left
    if (distance === 0 && next.width === previous.width) return
    const middleLeft = Math.min(previous.left, next.left)
    const middleWidth = Math.abs(distance) + Math.max(previous.width, next.width)
    selection.animate([
      { left: `${previous.left}px`, width: `${previous.width}px` },
      {
        // 钉钉中间帧是一枚连接起点与终点的长透镜，而非仅把药丸略微拉宽。
        left: `${middleLeft}px`,
        width: `${middleWidth}px`,
        offset: 0.48,
      },
      { left: `${next.left}px`, width: `${next.width}px` },
    ], { duration: 420, easing: 'cubic-bezier(0.22, 0.8, 0.24, 1)' })
  }

  useLayoutEffect(() => {
    measureSelection(true)
  }, [location.pathname])

  useEffect(() => {
    const onResize = () => measureSelection(false)
    const motionPreference = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
    const onMotionPreferenceChange = () => measureSelection(false)
    window.addEventListener('resize', onResize)
    motionPreference?.addEventListener?.('change', onMotionPreferenceChange)
    return () => {
      window.removeEventListener('resize', onResize)
      motionPreference?.removeEventListener?.('change', onMotionPreferenceChange)
    }
  }, [location.pathname])

  return (
    <header className="relative z-20 mx-3 mt-3 flex h-12 flex-shrink-0 items-center justify-center">
      <img
        src="/otter-icon.png"
        alt="Otter Buddy"
        className="absolute left-2 top-1/2 h-8 w-8 -translate-y-1/2 rounded-full shadow-otter"
      />

      <nav
        aria-label="主导航"
        data-testid="primary-nav"
        className="glass-nav max-w-[calc(100vw-6rem)] rounded-full"
      >
        {/* 折射只作用于复制的静态画布，菜单文字与图标不参与位移。 */}
        <span aria-hidden="true" className="glass-nav-effect">
          <span className="glass-nav-sample" />
        </span>
        <span aria-hidden="true" className="glass-nav-tint" />
        <div ref={contentRef} className="glass-nav-content flex items-center gap-0.5 overflow-x-auto p-1">
          <span
            ref={selectionRef}
            aria-hidden="true"
            className="glass-nav-selection"
            style={{
              left: selectionBox.left,
              width: selectionBox.width,
              visibility: selectionBox.width === 0 ? 'hidden' : 'visible',
            }}
          >
            <span className="glass-nav-item-effect">
              <span className="glass-nav-sample" />
            </span>
            <span className="glass-nav-selection-tint" />
          </span>
          {NAV_ROUTES.map(route => {
            const Icon = ICONS[route.path] ?? MessageCircle
            const active = isActive(route.path)
            return (
              <Link
                key={route.path}
                to={route.nav ?? route.path}
                className={`glass-nav-item flex shrink-0 items-center rounded-full px-4 py-1.5 text-xs font-medium transition ${
                  active
                    ? 'nav-pill-active text-otter-700 font-semibold'
                    : 'text-stone-700 hover:text-stone-900'
                }`}
                data-active={active}
                aria-current={active ? 'page' : undefined}
              >
                <span className="glass-nav-item-content flex items-center gap-1.5">
                  <Icon className="w-3.5 h-3.5" />
                  {route.label}
                </span>
              </Link>
            )
          })}
        </div>

        {/* 直接位移复制的画布像素，Chrome 与 Safari 共用同一路径。 */}
        <svg aria-hidden="true" className="pointer-events-none absolute h-0 w-0" focusable="false">
          <defs>
            <filter
              id="nav-liquid-glass"
              x="-20%"
              y="-50%"
              width="140%"
              height="200%"
              colorInterpolationFilters="sRGB"
            >
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.001 0.006"
                numOctaves="1"
                seed="17"
                result="noise"
              />
              <feGaussianBlur in="noise" stdDeviation="3" result="smoothNoise" />
              <feDisplacementMap
                in="SourceGraphic"
                in2="smoothNoise"
                scale="80"
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
          </defs>
        </svg>
      </nav>
    </header>
  )
}
