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
      {children}
      <ToastContainer />
    </div>
  )
}
