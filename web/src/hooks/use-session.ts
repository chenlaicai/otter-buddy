/**
 * 会话状态钩子（issue #1868 阶段 2）：启动时探测会话，登录/登出/会话失效统一收敛。
 */
import { useCallback, useEffect, useState } from 'react'
import * as authApi from '../api/auth'

export type SessionState = 'loading' | 'authenticated' | 'unauthenticated'

export function useSession(onLoggedIn?: () => void): {
  state: SessionState
  login: (token: string) => Promise<void>
  logout: () => Promise<void>
} {
  const [state, setState] = useState<SessionState>('loading')

  useEffect(() => {
    let cancelled = false
    authApi.fetchSession()
      .then(() => { if (!cancelled) setState('authenticated') })
      .catch(() => { if (!cancelled) setState('unauthenticated') })
    const onUnauthorized = () => setState('unauthenticated')
    window.addEventListener('otter:unauthorized', onUnauthorized)
    return () => {
      cancelled = true
      window.removeEventListener('otter:unauthorized', onUnauthorized)
    }
  }, [])

  const login = useCallback(async (token: string) => {
    await authApi.login(token)
    setState('authenticated')
    onLoggedIn?.()
  }, [onLoggedIn])

  const logout = useCallback(async () => {
    await authApi.logout()
    setState('unauthenticated')
  }, [])

  return { state, login, logout }
}