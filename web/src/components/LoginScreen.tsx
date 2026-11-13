/**
 * 登录屏（issue #1868 阶段 2）：单用户本机部署的 owner token 登录。
 * token 来源：env OTTER_OWNER_TOKEN 或首启自动生成于 data/owner-token。
 */
import { useState } from 'react'
import type { FormEvent } from 'react'

interface LoginScreenProps {
  onLogin: (token: string) => Promise<void>
  error: string | null
}

export function LoginScreen({ onLogin, error }: LoginScreenProps) {
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!token.trim() || submitting) return
    setSubmitting(true)
    try {
      await onLogin(token.trim())
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center">
      <div className="w-full max-w-sm rounded-2xl border border-otter-200 bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold text-otter-900">登录 Otter Buddy</h1>
        <p className="mb-6 text-sm text-otter-500">本机单用户中枢：输入 owner token 继续。</p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="password"
            data-testid="owner-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="owner token"
            autoFocus
            className="rounded-lg border border-otter-200 px-3 py-2 text-sm outline-none focus:border-otter-400"
          />
          {error && <p className="text-sm text-red-600" data-testid="login-error">{error}</p>}
          <button
            type="submit"
            data-testid="login-submit"
            disabled={!token.trim() || submitting}
            className="rounded-lg bg-otter-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {submitting ? '登录中…' : '登录'}
          </button>
        </form>
      </div>
    </div>
  )
}