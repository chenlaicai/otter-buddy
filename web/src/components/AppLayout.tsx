import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { TopBar } from './TopBar'
import { ToastContainer } from './Toast'
import { GlobalConversationPoller } from './FloatingAssistant/global-conversation-store'
import { FloatingAssistant } from './FloatingAssistant/FloatingAssistant'
import { LoginScreen } from './LoginScreen'
import { useSession } from '../hooks/use-session'
import * as api from '../api/client'
import { ApiError } from '../api/client'

/**
 * SPA 根布局（F20260920spa）：TopBar + 内容区 + Toast。
 * 由 main.tsx 的根 Route 渲染一次，子路由通过 <Outlet /> 填充内容。
 *
 * Why: min-h-0 + overflow-y-auto 兜底——
 * body overflow:hidden + h-screen 骨架下，页面忘写滚动容器会让超出视口的内容被裁掉且无滚动条
 * （IM 页第三次现场，前两次 #503/#628，F20260902imsc）。
 * 显式 overflow-* 声明优先于本兜底，不受影响。
 *
 * F20260924wast：挂载浮动獭（全页面常驻）+ 全局轮询单例（M2：App 层一份 5s 轮询，
 * 对话列表页与浮动獭共用）。开关 = assistant.web.enabled（settings DTO 下发）。
 */
/** 全屏加载占位（会话探测/懒加载页面共用形态） */
export function LoadingFullScreen() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="flex gap-1">
        <span className="w-2 h-2 rounded-full bg-otter-400 animate-dot" />
        <span className="w-2 h-2 rounded-full bg-otter-400 animate-dot" style={{ animationDelay: '0.15s' }} />
        <span className="w-2 h-2 rounded-full bg-otter-400 animate-dot" style={{ animationDelay: '0.3s' }} />
      </div>
    </div>
  )
}

export function AppLayout() {
  const [assistantWebEnabled, setAssistantWebEnabled] = useState<boolean | null>(null)
  const [loginError, setLoginError] = useState<string | null>(null)
  // #1868 阶段 2：会话门——未登录不渲染业务布局（聚合页面/浮动獭不 401 空转）
  const { state, login } = useSession()

  useEffect(() => {
    if (state !== 'authenticated') return
    api.getSettings()
      .then(s => setAssistantWebEnabled(s.assistantWebEnabled !== false))
      .catch(() => setAssistantWebEnabled(true)) // settings 拉取失败默认开（降级不藏入口）
  }, [state])

  if (state === 'loading') return <LoadingFullScreen />
  if (state === 'unauthenticated') {
    return (
      <LoginScreen
        error={loginError}
        onLogin={async (token) => {
          try {
            setLoginError(null)
            await login(token)
          } catch (err) {
            setLoginError(err instanceof ApiError ? err.message : '登录失败')
          }
        }}
      />
    )
  }

  return (
    <div className="flex flex-col h-screen">
      <TopBar />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="app-content-scroll">
        <Outlet />
      </div>
      <ToastContainer />
      {/* F20260924wast：全局轮询单例 + 浮动獭（enabled 未知时不渲染——避免关掉后闪现） */}
      {assistantWebEnabled !== false && <GlobalConversationPoller />}
      {assistantWebEnabled === true && <FloatingAssistant enabled={assistantWebEnabled} />}
    </div>
  )
}
