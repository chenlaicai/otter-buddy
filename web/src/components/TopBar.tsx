import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { MessageCircle, Search, Package, Settings, Activity, ClipboardList, type LucideIcon } from 'lucide-react'
import { NAV_ROUTES } from '@contract/web/pages'
import { GlassLens } from './liquid-glass/glass-lens'

const ICONS: Record<string, LucideIcon> = {
  '/conversation': MessageCircle,
  '/memory': Search,
  '/skills': Package,
  '/im': MessageCircle,
  '/health': Activity,
  '/activity': ClipboardList,
  '/settings': Settings,
}

/** SPA TopBar —— 系统图标与名称 + 居中 Liquid Glass 主导航，由 AppLayout 渲染一次。 */
export function TopBar() {
  const location = useLocation()
  const [reducedTransparency, setReducedTransparency] = useState(false)

  function isActive(path: string): boolean {
    if (path === '/conversation') {
      return location.pathname === '/conversation'
        || location.pathname === '/'
        || location.pathname.startsWith('/conversation/')
    }
    return location.pathname === path
  }

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const preference = window.matchMedia('(prefers-reduced-transparency: reduce)')
    const update = () => setReducedTransparency(preference.matches)
    update()
    preference.addEventListener?.('change', update)
    return () => preference.removeEventListener?.('change', update)
  }, [])

  const activeRoute = NAV_ROUTES.find(route => isActive(route.path))?.path ?? null

  return (
    <header className="relative z-20 mx-3 mt-3 flex h-12 flex-shrink-0 items-center justify-center">
      <div className="absolute left-2 top-1/2 flex -translate-y-1/2 items-center gap-2" data-testid="system-brand">
        <img
          src="/otter-icon.png"
          alt="Otter Buddy"
          className="h-8 w-8 rounded-full shadow-otter"
        />
        <span className="topbar-brand-name">Otter Buddy</span>
      </div>

      <nav
        aria-label="主导航"
        data-testid="primary-nav"
        data-glass-host=""
        className="glass-nav max-w-[calc(100vw-11rem)] rounded-full"
      >
        <GlassLens value={activeRoute} disabled={reducedTransparency} />
        <div className="glass-nav-content flex items-center gap-0.5 overflow-x-auto p-1">
          {NAV_ROUTES.map(route => {
            const Icon = ICONS[route.path] ?? MessageCircle
            const active = isActive(route.path)
            return (
              <Link
                key={route.path}
                to={route.nav ?? route.path}
                data-glass-option=""
                className={`glass-nav-item flex shrink-0 items-center rounded-full px-4 py-1.5 text-xs font-medium ${
                  active ? 'nav-pill-active text-stone-800 font-semibold' : 'text-stone-700 hover:text-stone-900'
                }`}
                data-active={active}
                data-route={route.path}
                aria-current={active ? 'page' : undefined}
              >
                {active && <span aria-hidden="true" data-glass-highlight="" className="glass-nav-highlight" />}
                <span className="glass-nav-item-content flex items-center gap-1.5">
                  <Icon className="w-3.5 h-3.5" />
                  {route.label}
                </span>
              </Link>
            )
          })}
        </div>
      </nav>
    </header>
  )
}
