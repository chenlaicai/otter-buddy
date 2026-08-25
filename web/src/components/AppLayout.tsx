import { type ReactNode } from 'react'
import { TopBar } from './TopBar'
import { ToastContainer } from './Toast'

interface AppLayoutProps {
  activeView: 'conversation' | 'memory' | 'skills' | 'settings' | 'connections' | 'health'
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
