/**
 * SPA 单一入口（F20260920spa）：
 * 所有页面通过 React Router 客户端路由渲染，TopBar/Sidebar 只渲染一次。
 * 路由级懒加载（React.lazy + Suspense）——未访问的页面代码不下载。
 * 
 * D1 修复：迁移到数据路由（createBrowserRouter）以支持 useBlocker
 * Why: useBlocker 是数据路由专属 API，组件式 BrowserRouter 不支持
 */
import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom'
import './styles/globals.css'
import { AppLayout } from './components/AppLayout'

// 路由级懒加载：每个页面独立 chunk
const ConversationListPage = lazy(() => import('./pages/conversation-list/index'))
const ConversationPage = lazy(() => import('./pages/conversation/index'))
const MemorySearchPage = lazy(() => import('./pages/memory/index'))
const SkillsPage = lazy(() => import('./pages/skills/index'))
const ImPage = lazy(() => import('./pages/im/index'))
const HealthPage = lazy(() => import('./pages/health/index'))
const ActivityPage = lazy(() => import('./pages/activity/index'))
const SettingsPage = lazy(() => import('./pages/settings/index'))

function LoadingFallback() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="flex gap-1">
        <span className="w-2 h-2 rounded-full bg-otter-400 animate-dot" />
        <span className="w-2 h-2 rounded-full bg-otter-400 animate-dot" style={{ animationDelay: '0.15s' }} />
        <span className="w-2 h-2 rounded-full bg-otter-400 animate-dot" style={{ animationDelay: '0.3s' }} />
      </div>
    </div>
  )
}

// D1 修复：使用数据路由（createBrowserRouter）替代组件式 BrowserRouter
// Why: useBlocker 是数据路由专属 API，组件式 BrowserRouter 不支持
const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/conversation" replace /> },
      { path: 'conversation', element: <Suspense fallback={<LoadingFallback />}><ConversationListPage /></Suspense> },
      { path: 'conversation/:id', element: <Suspense fallback={<LoadingFallback />}><ConversationPage /></Suspense> },
      { path: 'memory', element: <Suspense fallback={<LoadingFallback />}><MemorySearchPage /></Suspense> },
      { path: 'skills', element: <Suspense fallback={<LoadingFallback />}><SkillsPage /></Suspense> },
      { path: 'im', element: <Suspense fallback={<LoadingFallback />}><ImPage /></Suspense> },
      { path: 'health', element: <Suspense fallback={<LoadingFallback />}><HealthPage /></Suspense> },
      { path: 'activity', element: <Suspense fallback={<LoadingFallback />}><ActivityPage /></Suspense> },
      { path: 'settings', element: <Suspense fallback={<LoadingFallback />}><SettingsPage /></Suspense> },
      // 兜底：未匹配路径重定向到对话列表
      { path: '*', element: <Navigate to="/conversation" replace /> },
    ],
  },
])

const root = createRoot(document.getElementById('root')!)
root.render(<RouterProvider router={router} />)
