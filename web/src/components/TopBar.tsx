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

/** SPA TopBar —— 独立系统图标 + 居中悬浮主导航，由 AppLayout 渲染一次 */
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
        className="glass-nav flex max-w-[calc(100vw-6rem)] items-center gap-0.5 overflow-x-auto rounded-full p-1"
      >
        {NAV_ROUTES.map(route => {
          const Icon = ICONS[route.path] ?? MessageCircle
          const active = isActive(route.path)
          return (
            <Link
              key={route.path}
              to={route.nav ?? route.path}
              className={`flex shrink-0 items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium transition ${
                active
                  ? 'nav-pill-active text-otter-700 font-semibold'
                  : 'text-stone-700 hover:text-stone-900'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {route.label}
            </Link>
          )
        })}
      </nav>
    </header>
  )
}
