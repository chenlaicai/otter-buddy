import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { MessageCircle, Search, Package, Settings, Activity, ClipboardList, type LucideIcon } from 'lucide-react'
import { NAV_ROUTES } from '@contract/web/pages'

interface ExecutionMachineDTO {
  id: string
  name?: string
}

interface ExecutionMachinesDTO {
  machines: ExecutionMachineDTO[]
  currentMachineId: string
}

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

/** SPA TopBar —— 由 AppLayout 渲染一次，导航用 <Link> 客户端路由 */
export function TopBar() {
  const location = useLocation()
  // #1868 阶段 2：当前执行机投影（阶段 2 恒为本机，后续多终端接入后随侧边栏选持久机变化）
  const [machineName, setMachineName] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/execution-machines', { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((d: ExecutionMachinesDTO) => {
        if (!cancelled) {
          const cur = d.machines.find(m => m.id === d.currentMachineId)
          setMachineName(cur?.name ?? d.currentMachineId)
        }
      })
      .catch(() => { if (!cancelled) setMachineName(null) })
    return () => { cancelled = true }
  }, [])

  /** 判断当前路由是否激活：精确匹配或前缀匹配（/conversation 匹配 /conversation/xxx） */
  function isActive(path: string): boolean {
    if (path === '/conversation') {
      return location.pathname === '/conversation' || location.pathname === '/'
    }
    return location.pathname === path
  }

  return (
    <header className="flex items-center px-5 h-12 glass-strong z-20 flex-shrink-0 mx-3 mt-3 rounded-2xl">
      {/* Logo left-aligned */}
      <div className="flex items-center gap-2 flex-1">
        <img src="/otter-icon.png" alt="Otter Buddy" className="w-6 h-6 rounded-full" />
        <span className="text-sm font-bold tracking-tight text-otter-600">Otter Buddy</span>
      </div>

      {/* Tabs centered */}
      <nav className="flex gap-0.5 p-1 rounded-full" style={{ background: 'rgba(139,111,71,0.06)' }}>
        {NAV_ROUTES.map(route => {
          const Icon = ICONS[route.path] ?? MessageCircle
          const active = isActive(route.path)
          return (
            <Link
              key={route.path}
              to={route.nav ?? route.path}
              className={`px-4 py-1 text-xs font-medium rounded-full transition flex items-center gap-1.5 ${
                active
                  ? 'nav-pill-active text-otter-600 font-semibold'
                  : 'text-stone-500 hover:text-stone-700'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {route.label}
            </Link>
          )
        })}
      </nav>

      {/* Right：当前执行机投影（数据不可得时静默隐藏，不阻塞布局） */}
      <div className="flex-1 flex justify-end">
        {machineName && (
          <span
            data-testid="execution-machine"
            title={`当前执行机：${machineName}`}
            className="px-2.5 py-1 text-xs font-medium rounded-full text-otter-600"
            style={{ background: 'rgba(139,111,71,0.06)' }}
          >
            执行机：{machineName}
          </span>
        )}
      </div>
    </header>
  )
}
