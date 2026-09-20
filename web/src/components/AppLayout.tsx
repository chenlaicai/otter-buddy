import { Outlet } from 'react-router-dom'
import { TopBar } from './TopBar'
import { ToastContainer } from './Toast'

/**
 * SPA 根布局（F20260920spa）：TopBar + 内容区 + Toast。
 * 由 main.tsx 的根 Route 渲染一次，子路由通过 <Outlet> 填充内容。
 *
 * Why: min-h-0 + overflow-y-auto 兜底——
 * body overflow:hidden + h-screen 骨架下，页面忘写滚动容器会让超出视口的内容被裁掉且无滚动条
 * （IM 页第三次现场，前两次 #503/#628，F20260902imsc）。
 * 显式 overflow-* 声明优先于本兜底，不受影响。
 */
export function AppLayout() {
  return (
    <div className="flex flex-col h-screen">
      <TopBar />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="app-content-scroll">
        <Outlet />
      </div>
      <ToastContainer />
    </div>
  )
}
