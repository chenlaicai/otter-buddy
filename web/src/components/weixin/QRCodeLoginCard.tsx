import { useState, useRef, useEffect, useCallback } from 'react'
import { showToast } from '../Toast'
import * as api from '../../api/client'
import type { WeixinLoginSessionDTO } from '../../api/client'

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

interface QRCodeLoginCardProps {
  onLoginSuccess?: () => void
}

export function QRCodeLoginCard({ onLoginSuccess }: QRCodeLoginCardProps) {
  const [session, setSession] = useState<WeixinLoginSessionDTO | null>(null)
  const [starting, setStarting] = useState(false)
  const pollTimer = useRef<number | null>(null)

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
            onLoginSuccess?.()
          } else if (s.status === 'error') {
            showToast(s.error ?? '登录失败', 'error')
          }
        }
      } catch {
        // 会话 404（服务重启/超10分钟）：停轮询
        if (pollTimer.current) window.clearInterval(pollTimer.current)
      }
    }, POLL_INTERVAL_MS)
  }, [onLoginSuccess])

  useEffect(() => {
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current)
    }
  }, [])

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

  const handleRetry = () => {
    setSession(null)
    handleStart()
  }

  return (
    <div className="glass-card rounded-2xl p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-stone-800">微信扫码登录</h3>
        <button
          onClick={handleStart}
          disabled={starting || (session !== null && ['pending', 'waiting_scan', 'scaned'].includes(session.status))}
          className="px-4 py-2 text-sm text-white rounded-xl shadow-glow transition disabled:opacity-50"
          style={{ background: 'linear-gradient(135deg,#8B7E72,#6B6157)' }}
        >
          {starting ? '启动中...' : '重新扫码'}
        </button>
      </div>

      {/* 扫码登录会话卡片 */}
      {session && session.status !== 'cancelled' && (
        <div className="flex flex-col items-center gap-4">
          <p className="text-sm text-stone-600">{STATUS_LABEL[session.status]}</p>

          {session.qrcodePng && ['waiting_scan', 'scaned', 'expired'].includes(session.status) && (
            <div className={`relative ${session.status === 'expired' ? 'opacity-40' : ''}`}>
              <img
                src={session.qrcodePng}
                alt="微信登录二维码"
                className="w-64 h-64 rounded-xl border border-stone-200 bg-white p-2"
              />
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
              <button onClick={handleRetry} className="ml-2 underline">重试</button>
            </div>
          )}

          {['pending', 'waiting_scan', 'scaned'].includes(session.status) && (
            <button onClick={handleCancel} className="text-xs text-stone-400 hover:text-stone-600">
              取消
            </button>
          )}
        </div>
      )}

      {/* 无会话时显示说明 */}
      {!session && (
        <div className="text-center py-8 text-stone-400">
          <p className="text-sm">点击「重新扫码」开始微信登录</p>
          <p className="text-xs mt-1">扫码后微信账号将自动连接</p>
        </div>
      )}
    </div>
  )
}