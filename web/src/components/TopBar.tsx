import { MessageCircle, Search, Package, Settings, Link2, Activity, type LucideIcon } from 'lucide-react'
import { MPA_PAGES } from '@contract/web/pages'

/** #487（F20260827mpss）：ViewKey 从清单派生（编译期穷尽），不再手写 union */
export type ViewKey = (typeof MPA_PAGES)[number]['entry']

/** icon 是纯视觉实现细节，留在组件层维护（entry → icon 组件映射）。
 *  fallback + console.warn：新增页面忘配 icon 只视觉降级不编译失败，开发者可在控制台发现遗漏 */
const ICONS: Record<string, LucideIcon> = {
  index: MessageCircle,
  memory: Search,
  skills: Package,
  settings: Settings,
  connections: Link2,
  health: Activity,
}

/** #487：tabs 从单一清单派生。
 *  排除规则：带路径参数且未声明 nav 的页面（conversation 详情页）不进入导航——
 *  设计稿示例直接 map 会把详情页渲染成导航项，此处为偏差修正（见特性文档「与设计的差异」）。
 *  href 缺省 = pattern 去路径参数（index 页的 nav: '/' 显式声明） */
const tabs: { key: ViewKey; label: string; href: string; icon: LucideIcon }[] = MPA_PAGES
  .filter(p => p.nav !== undefined || !p.pattern.includes(':'))
  .map(p => {
    const configured = ICONS[p.entry]
    if (!configured) console.warn(`[TopBar] 页面 "${p.entry}" 未配置 icon，已回退默认 icon——请在 ICONS 映射中补充`)
    return {
      key: p.entry,
      label: p.label,
      href: p.nav ?? p.pattern.replace(/\/:[^/]+/g, ''),
      icon: configured ?? MessageCircle,
    }
  })

/** Global unified TopBar - same component on all pages (← UA-10, UA-12) */
export function TopBar({ activeView }: { activeView: ViewKey }) {
  return (
    <header className="flex items-center px-5 h-12 glass-strong z-20 flex-shrink-0 mx-3 mt-3 rounded-2xl">
      {/* Logo left-aligned */}
      <div className="flex items-center gap-2 flex-1">
        <img src="/otter-icon.png" alt="Otter Buddy" className="w-6 h-6 rounded-full" />
        <span className="text-sm font-bold tracking-tight text-otter-600">Otter Buddy</span>
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
