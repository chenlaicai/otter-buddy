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

/** SPA TopBar —— 独立系统图标 + 居中 Liquid Glass 主导航，由 AppLayout 渲染一次 */
export function TopBar() {
  const location = useLocation()

  /** 判断当前路由是否激活：精确匹配或前缀匹配（/conversation 匹配 /conversation/xxx） */
  function isActive(path: string): boolean {
    if (path === '/conversation') {
      return location.pathname === '/conversation' || location.pathname === '/'
    }
    return location.pathname === path
  }

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
        <div className="glass-nav-content flex items-center gap-0.5 overflow-x-auto p-1">
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
              >
                <span aria-hidden="true" className="glass-nav-item-effect">
                  <span className="glass-nav-sample" />
                </span>
                <span aria-hidden="true" className="glass-nav-item-tint" />
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
