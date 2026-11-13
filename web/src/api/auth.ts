/**
 * 统一接入登录（issue #1868 阶段 2）：本机浏览器登录/session 三端点客户端。
 * 登录成功由服务端派发 httpOnly 会话 cookie——后续 request() 与 SSE 直接凭 cookie，
 * 不再自报 X-Otter 声明头（web 身份值源从常量换成会话，对齐 F20261019autz 取舍③）。
 */
import { ApiError } from './client'

export interface SessionIdentity {
  userId: string
  role: string
}

export interface SessionInfo {
  ok: true
  identity: SessionIdentity
}

async function authRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/auth/${url}`, {
    ...init,
    credentials: 'same-origin',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new ApiError(body.error ?? res.statusText, res.status, body.code)
  }
  return res.json() as Promise<T>
}

export function login(token: string): Promise<SessionInfo> {
  return authRequest<SessionInfo>('login', { method: 'POST', body: JSON.stringify({ token }) })
}

export function logout(): Promise<{ ok: true }> {
  return authRequest<{ ok: true }>('logout', { method: 'POST' })
}

export function fetchSession(): Promise<SessionInfo> {
  return authRequest<SessionInfo>('session')
}