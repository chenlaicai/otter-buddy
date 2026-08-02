import { MessageCircle, Search, Package, Settings, Link2 } from 'lucide-react'

type ViewKey = 'conversation' | 'memory' | 'skills' | 'settings' | 'connections'

const tabs: { key: ViewKey; label: string; href: string; icon: typeof MessageCircle }[] = [
  { key: 'conversation', label: '对话', href: '/', icon: MessageCircle },
  { key: 'memory', label: '记忆搜索', href: '/memory', icon: Search },
  { key: 'skills', label: '能力库', href: '/skills', icon: Package },
  { key: 'connections', label: '连接', href: '/connections', icon: Link2 },
  { key: 'settings', label: '设置', href: '/settings', icon: Settings },
]

/** Global unified TopBar - same component on all pages (← UA-10, UA-12) */
export function TopBar({ activeView }: { activeView: ViewKey }) {
  return (
    <header className="flex items-center px-5 h-12 glass-strong z-20 flex-shrink-0 mx-3 mt-3 rounded-2xl">
      {/* Logo left-aligned */}
      <div className="flex items-center gap-2 flex-1">
        <img src="/otter-icon.png" alt="Otter Buddy" className="w-6 h-6 rounded-full" />
        <span className="text-sm font-bold tracking-tight text-otter-600">Otter Buddy <span className="text-xs text-stone-400">v20260730-im</span></span>
      </div>

      {/* Tabs centered (← UA-12) */}
      <nav className="flex gap-0.5 p-1 rounded-full" style={{ background: 'rgba(139,111,71,0.06)' }}>
        {tabs.map(tab => {
          const Icon = tab.icon
          const isActive = tab.key === activeView
          return (
            <a
              key={tab.key}
              href={tab.href}
              className={`px-4 py-1 text-xs font-medium rounded-full transition flex items-center gap-1.5 ${
                isActive
                  ? 'nav-pill-active text-otter-600 font-semibold'
                  : 'text-stone-500 hover:text-stone-700'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </a>
          )
        })}
      </nav>

      {/* Right spacer for centering */}
      <div className="flex-1" />
    </header>
  )
}
