import { useState, useRef, useEffect, useCallback } from 'react'
import { showToast } from '../Toast'
import * as api from '../../api/client'
import type { FeishuLoginSessionDTO } from '../../api/client'

/**
 * F20260928fsqr：飞书扫码接入卡片（微信 QRCodeLoginCard 同构）。
 *
 * 差异：飞书 SDK registerApp 无「已扫码等确认」中间态（waiting_scan 直达终态）；
 * 起名步骤流入 appPreset.name（扫码确认页应用名预填，EchoAgent 同构）。
 */

const STATUS_LABEL: Record<FeishuLoginSessionDTO['status'], string> = {
  pending: '正在申请二维码...',
  waiting_scan: '等待扫码——确认页可选「创建新应用」或「选择已有应用」（选已有时将接管该应用的消息事件）',
  success: '飞书应用已接入，助理线就绪',
  expired: '二维码已过期',
  error: '接入失败',
  cancelled: '已取消',
}

const POLL_INTERVAL_MS = 2000

interface FeishuQRCodeLoginCardProps {
  /** 助理线名（扫码页起名；appPreset 预填同源） */
  lineName?: string
  onLoginConfirmed?: (appId?: string) => void
}

export function FeishuQRCodeLoginCard({ lineName, onLoginConfirmed }: FeishuQRCodeLoginCardProps) {
  const [session, setSession] = useState<FeishuLoginSessionDTO | null>(null)
  const [starting, setStarting] = useState(false)
  const pollTimer = useRef<number | null>(null)

  // 轮询登录状态直到终态（微信同款 2s 轮询）
  const pollSession = useCallback((id: string) => {
    if (pollTimer.current) window.clearInterval(pollTimer.current)
    pollTimer.current = window.setInterval(async () => {
      try {
        const s = await api.getFeishuLogin(id)
        setSession(s)
        if (['success', 'expired', 'error', 'cancelled'].includes(s.status)) {
          if (pollTimer.current) window.clearInterval(pollTimer.current)
          if (s.status === 'success') {
            showToast(`「${lineName ?? '助理'}」已连接`, 'success')
            onLoginConfirmed?.(s.appId)
          } else if (s.status === 'error') {
            showToast(s.error ?? '接入失败', 'error')
          }
        }
      } catch {
        // 会话过期/网络异常：停轮询（前端留在最后已知态）
        if (pollTimer.current) window.clearInterval(pollTimer.current)
      }
    }, POLL_INTERVAL_MS)
  }, [onLoginConfirmed, lineName])

  useEffect(() => {
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current)
    }
  }, [])

  const handleStart = async () => {
    setStarting(true)
    try {
      const s = await api.startFeishuLogin(lineName?.trim() || undefined)
      setSession(s)
      pollSession(s.id)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '发起接入失败', 'error')
    } finally {
      setStarting(false)
    }
  }

  const handleCancel = async () => {
    if (!session) return
    try {
      await api.cancelFeishuLogin(session.id)
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
    <div className="rounded-xl border border-stone-200/60 bg-white/30 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-semibold text-stone-800 flex-shrink-0">扫码接入飞书</h3>
          {lineName && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-teal-50 text-teal-600 truncate" title={lineName}>
              助理「{lineName}」
            </span>
          )}
        </div>
        <button
          onClick={handleStart}
          disabled={starting || (session !== null && ['pending', 'waiting_scan'].includes(session.status))}
          className="px-3.5 py-1.5 text-xs text-white rounded-lg transition disabled:opacity-50 flex-shrink-0"
          style={{ background: 'linear-gradient(135deg,#8B7E72,#6B6157)' }}
        >
          {starting ? '启动中...' : session === null ? '显示二维码' : '重新扫码'}
        </button>
      </div>

      {session && session.status !== 'cancelled' && (
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-stone-600">{STATUS_LABEL[session.status]}</p>

          {session.qrcodePng && ['waiting_scan', 'expired'].includes(session.status) && (
            <div className={`relative ${session.status === 'expired' ? 'opacity-40' : ''}`}>
              <img
                src={session.qrcodePng}
                alt="飞书接入二维码"
                className="w-56 h-56 rounded-xl border border-stone-200 bg-white p-2"
              />
            </div>
          )}

          {session.status === 'pending' && (
            <div className="w-56 h-56 rounded-xl bg-white/30 animate-pulse flex items-center justify-center">
              <span className="text-xs text-stone-400">二维码生成中...</span>
            </div>
          )}

          {session.status === 'success' && (
            <div className="w-full p-3 rounded-xl bg-green-50 text-sm text-green-700">
              飞书应用已接入{lineName ? `，「${lineName}」` : ''}正在就绪...
            </div>
          )}

          {(session.status === 'expired' || session.status === 'error') && (
            <div className="w-full p-3 rounded-xl bg-red-50 text-sm text-red-600">
              {session.status === 'expired' ? '二维码已过期，请重新发起' : (session.error ?? '接入失败')}
              <button onClick={handleRetry} className="ml-2 underline">重试</button>
            </div>
          )}

          {['pending', 'waiting_scan'].includes(session.status) && (
            <button onClick={handleCancel} className="text-xs text-stone-400 hover:text-stone-600">
              取消
            </button>
          )}
        </div>
      )}

      {!session && (
        <div className="text-center py-6 text-stone-400">
          <p className="text-sm">点击「显示二维码」，用飞书扫码确认创建应用</p>
          <p className="text-xs mt-1">无需填写任何凭证，扫码即用</p>
        </div>
      )}
    </div>
  )
}
