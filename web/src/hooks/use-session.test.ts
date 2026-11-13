// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('../api/auth', () => ({
  fetchSession: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}))

import * as authApi from '../api/auth'
import { useSession } from './use-session'

describe('useSession（会话门状态机）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('启动探测成功 → authenticated', async () => {
    vi.mocked(authApi.fetchSession).mockResolvedValue({ ok: true, identity: { userId: 'owner', role: 'admin' } })
    const { result } = renderHook(() => useSession())
    expect(result.current.state).toBe('loading')
    await waitFor(() => expect(result.current.state).toBe('authenticated'))
  })

  it('启动探测失败 → unauthenticated', async () => {
    vi.mocked(authApi.fetchSession).mockRejectedValue(new Error('401'))
    const { result } = renderHook(() => useSession())
    await waitFor(() => expect(result.current.state).toBe('unauthenticated'))
  })

  it('otter:unauthorized 广播 → 切回 unauthenticated', async () => {
    vi.mocked(authApi.fetchSession).mockResolvedValue({ ok: true, identity: { userId: 'owner', role: 'admin' } })
    const { result } = renderHook(() => useSession())
    await waitFor(() => expect(result.current.state).toBe('authenticated'))
    act(() => { window.dispatchEvent(new CustomEvent('otter:unauthorized')) })
    expect(result.current.state).toBe('unauthenticated')
  })

  it('login 成功 → authenticated 并触发 onLoggedIn；logout → unauthenticated', async () => {
    vi.mocked(authApi.fetchSession).mockRejectedValue(new Error('401'))
    const onLoggedIn = vi.fn()
    const { result } = renderHook(() => useSession(onLoggedIn))
    await waitFor(() => expect(result.current.state).toBe('unauthenticated'))

    vi.mocked(authApi.login).mockResolvedValue({ ok: true, identity: { userId: 'owner', role: 'admin' } })
    await act(async () => { await result.current.login('secret') })
    expect(result.current.state).toBe('authenticated')
    expect(onLoggedIn).toHaveBeenCalled()

    vi.mocked(authApi.logout).mockResolvedValue({ ok: true })
    await act(async () => { await result.current.logout() })
    expect(result.current.state).toBe('unauthenticated')
  })
})