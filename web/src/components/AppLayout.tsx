import { type ReactNode } from 'react'
import { TopBar, type ViewKey } from './TopBar'
import { ToastContainer } from './Toast'

interface AppLayoutProps {
  /** #487（F20260827mpss）：从 TopBar 的清单派生类型 re-export，消除手写 union 副本（第 6 处副本） */
  activeView: ViewKey
  children: ReactNode
  showRightPanel?: boolean
  wsBar?: ReactNode
}

/** MPA page layout: TopBar + content area */
export function AppLayout({ activeView, children, wsBar }: AppLayoutProps) {
  return (
    <div className="flex flex-col h-screen">
      <TopBar activeView={activeView} />
      {wsBar}
      {/* Why: 主内容区默认可滚动 —— body overflow:hidden + h-screen 骨架下，页面忘写滚动容器
          会让超出视口的内容被裁掉且无滚动条（IM 页第三次现场，前两次 #503/#628，F20260902imsc）。
          兜底放骨架层而非每个页面自查：新页面零成本获得滚动。
          min-h-0：让自带 overflow-hidden 内滚的页面（conversation 三栏）作为 flex 子项正常收缩，
          显式 overflow-* 声明优先于本兜底，不受影响。 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
      <ToastContainer />
    </div>
  )
}
