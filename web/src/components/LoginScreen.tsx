/**
 * 登录屏（issue #1868 阶段 2）：单用户本机部署的登录口令登录。
 * 口令来源：config auth.ownerPassword / env OTTER_OWNER_PASSWORD / 首启自动生成于 data/owner-password。
 */
import { useState } from 'react'
import type { FormEvent } from 'react'

interface LoginScreenProps {
  onLogin: (password: string) => Promise<void>
  error: string | null
}

export function LoginScreen({ onLogin, error }: LoginScreenProps) {
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!password.trim() || submitting) return
    setSubmitting(true)
    try {
      await onLogin(password.trim())
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center">
      <div className="w-full max-w-sm rounded-2xl border border-otter-200 bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold text-otter-900">登录 Otter Buddy</h1>
        <p className="mb-6 text-sm text-otter-500">本机单用户中枢：输入登录口令继续。</p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="password"
            data-testid="owner-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="登录口令"
            autoFocus
            className="rounded-lg border border-otter-200 px-3 py-2 text-sm outline-none focus:border-otter-400"
          />
          {error && <p className="text-sm text-red-600" data-testid="login-error">{error}</p>}
          <button
            type="submit"
            data-testid="login-submit"
            disabled={!password.trim() || submitting}
            className="rounded-lg bg-otter-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {submitting ? '登录中…' : '登录'}
          </button>
        </form>
      </div>
    </div>
  )
}