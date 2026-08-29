import { useState, useEffect, useRef, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import '../../styles/globals.css'

import { AppLayout } from '../../components/AppLayout'
import { showToast } from '../../components/Toast'
import * as api from '../../api/client'
import type { WeixinLoginSessionDTO, WeixinAccountDTO } from '../../api/client'

/**
 * 微信连接管理页（issue #566）。
 *
 * 扫码登录：点击「连接微信」→ 后端发起会话 → 轮询状态渲染二维码 →
 * wait → scaned → success（账号热启动）。多账号列表 + 删除。
 */

const STATUS_LABEL: Record<WeixinLoginSessionDTO['status'], string> = {
  pending: '正在申请二维码...',
  waiting_scan: '等待扫码',
  scaned: '已扫码，请在微信中确认',
  success: '连接成功',
  expired: '二维码已过期',
  error: '连接失败',
  cancelled: '已取消',
}

const POLL_INTERVAL_MS = 2000

function WeixinLoginPage() {
  const [accounts, setAccounts] = useState<WeixinAccountDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState<WeixinLoginSessionDTO | null>(null)
  const [starting, setStarting] = useState(false)
  const pollTimer = useRef<number | null>(null)

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await api.listWeixinAccounts())
    } catch {
      showToast('加载微信账号失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadAccounts()
    return () => { if (pollTimer.current) window.clearInterval(pollTimer.current) }
  }, [loadAccounts])

  // 轮询登录状态直到终态
  const pollSession = useCallback((id: string) => {
    if (pollTimer.current) window.clearInterval(pollTimer.current)
    pollTimer.current = window.setInterval(async () => {
      try {
        const s = await api.getWeixinLogin(id)
        setSession(s)
        if (['success', 'expired', 'error', 'cancelled'].includes(s.status)) {
          if (pollTimer.current) window.clearInterval(pollTimer.current)
          if (s.status === 'success') {
            showToast('微信连接成功', 'success')
            loadAccounts()
          } else if (s.status === 'error') {
            showToast(s.error ?? '登录失败', 'error')
          }
        }
      } catch {
        // 会话 404（服务重启/超10分钟）：停轮询
        if (pollTimer.current) window.clearInterval(pollTimer.current)
      }
    }, POLL_INTERVAL_MS)
  }, [loadAccounts])

  const handleStart = async () => {
    setStarting(true)
    try {
      const s = await api.startWeixinLogin()
      setSession(s)
      pollSession(s.id)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '发起登录失败', 'error')
    } finally {
      setStarting(false)
    }
  }

  const handleCancel = async () => {
    if (!session) return
    try {
      await api.cancelWeixinLogin(session.id)
      if (pollTimer.current) window.clearInterval(pollTimer.current)
      setSession(null)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '取消失败', 'error')
    }
  }

  const handleDelete = async (accountId: string) => {
    try {
      await api.deleteWeixinAccount(accountId)
      showToast('已删除', 'success')
      loadAccounts()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  return (
    <AppLayout activeView="weixin">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-stone-800">微信连接</h1>
          <button
            onClick={handleStart}
            disabled={starting || (session !== null && ['pending', 'waiting_scan', 'scaned'].includes(session.status))}
            className="px-4 py-2 text-sm text-white rounded-xl shadow-glow transition disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg,#8B7E72,#6B6157)' }}
          >
            连接微信
          </button>
        </div>

        {/* 扫码登录会话卡片 */}
        {session && session.status !== 'cancelled' && (
          <div className="glass-card rounded-2xl p-6 mb-6">
            <div className="flex flex-col items-center gap-4">
              <p className="text-sm text-stone-600">{STATUS_LABEL[session.status]}</p>

              {session.qrcodePng && ['waiting_scan', 'scaned', 'expired'].includes(session.status) && (
                <div className={`relative ${session.status === 'expired' ? 'opacity-40' : ''}`}>
                  <img src={session.qrcodePng} alt="微信登录二维码" className="w-64 h-64 rounded-xl border border-stone-200 bg-white p-2" />
                  {session.status === 'scaned' && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="px-3 py-1 text-xs text-white rounded-full bg-green-500/90">已扫码</span>
                    </div>
                  )}
                </div>
              )}

              {session.status === 'pending' && (
                <div className="w-64 h-64 rounded-xl bg-white/30 animate-pulse flex items-center justify-center">
                  <span className="text-xs text-stone-400">二维码生成中...</span>
                </div>
              )}

              {session.status === 'success' && (
                <div className="w-full p-3 rounded-xl bg-green-50 text-sm text-green-700">
                  账号 {session.accountId} 已连接，重启后仍保持（token 已持久化）
                </div>
              )}

              {(session.status === 'expired' || session.status === 'error') && (
                <div className="w-full p-3 rounded-xl bg-red-50 text-sm text-red-600">
                  {session.status === 'expired' ? '二维码已过期，请重新发起' : (session.error ?? '登录失败')}
                  <button onClick={handleStart} className="ml-2 underline">重试</button>
                </div>
              )}

              {['pending', 'waiting_scan', 'scaned'].includes(session.status) && (
                <button onClick={handleCancel} className="text-xs text-stone-400 hover:text-stone-600">
                  取消
                </button>
              )}
            </div>
          </div>
        )}

        {/* 已连接账号列表 */}
        <h2 className="text-sm font-semibold text-stone-700 mb-3">已连接账号（{accounts.length}）</h2>
        {loading ? (
          <div className="space-y-3">
            {[1, 2].map(i => <div key={i} className="h-16 rounded-2xl bg-white/30 animate-pulse" />)}
          </div>
        ) : accounts.length === 0 ? (
          <div className="glass-card rounded-2xl p-8 text-center text-stone-400">
            <p className="text-sm">还没有连接的微信账号</p>
            <p className="text-xs mt-1">点击「连接微信」扫码开始</p>
          </div>
        ) : (
          <div className="space-y-3">
            {accounts.map(acc => (
              <div key={acc.id} className="glass-card rounded-2xl p-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-stone-800">{acc.id}</p>
                  <p className="text-xs text-stone-400 mt-0.5">
                    {acc.ilinkUserId ? `扫码人: ${acc.ilinkUserId} · ` : ''}添加于 {new Date(acc.addedAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs px-2 py-1 rounded-full ${acc.hasToken ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-500'}`}>
                    {acc.hasToken ? '已授权' : 'token 缺失'}
                  </span>
                  <button
                    onClick={() => handleDelete(acc.id)}
                    className="px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-lg transition"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<WeixinLoginPage />)
