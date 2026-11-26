import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, CircleCheck, CircleX, CircleHelp, CirclePause, Clock } from 'lucide-react'
import { Modal } from '../../components/Modal'
import { fmtTime } from '../../lib/utils'

/** 对话动作状态：全部执行机共用 central 台账，不再提供对话级选机或配对入口。 */

interface ActionEntry {
  actionId: string
  deviceId: string
  actionType: string
  status: string
  error: string | null
  createdAt: string
  settledAt: string | null
}

interface Props {
  conversationId: string
  onClose: () => void
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  requested: { label: '在途', cls: 'bg-blue-400/15 text-blue-500' },
  succeeded: { label: '成功', cls: 'bg-teal-400/15 text-teal-500' },
  failed: { label: '失败', cls: 'bg-red-400/15 text-red-500' },
  interrupted: { label: '中断', cls: 'bg-amber-400/15 text-amber-600' },
  unknown: { label: '不明', cls: 'bg-stone-400/15 text-stone-500' },
}

function ActionStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'succeeded': return <CircleCheck size={13} className="text-teal-500" />
    case 'failed': return <CircleX size={13} className="text-red-500" />
    case 'requested': return <Clock size={13} className="text-blue-500" />
    case 'interrupted': return <CirclePause size={13} className="text-amber-500" />
    default: return <CircleHelp size={13} className="text-stone-400" />
  }
}

export function ExecutionMachineModal({ conversationId, onClose }: Props) {
  const [actions, setActions] = useState<ActionEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const reload = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const res = await fetch(`/api/conversations/${conversationId}/remote-actions?limit=30`, { credentials: 'same-origin' })
      if (res.status === 401) {
        setError('登录已过期，请刷新页面重新登录（HTTP 401）')
        return
      }
      if (!res.ok) {
        setError(`动作状态加载失败（HTTP ${String(res.status)}）`)
        return
      }
      const body = await res.json() as { actions?: ActionEntry[] }
      setActions(Array.isArray(body.actions) ? body.actions : [])
    } catch {
      setError('动作状态加载失败（网络或服务不可用）')
    } finally {
      setLoaded(true)
      setRefreshing(false)
    }
  }, [conversationId])

  useEffect(() => { void reload() }, [reload])

  return (
    <Modal isOpen onClose={onClose} title="动作状态" width="max-w-lg">
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-stone-600">全部执行机动作（最近 30 条）</h3>
          <button
            type="button"
            onClick={() => void reload()}
            disabled={refreshing}
            className="text-stone-400 hover:text-stone-600 disabled:opacity-50"
            title="刷新动作状态"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : undefined} />
          </button>
        </div>

        {error && (
          <div role="alert" className="mb-2 text-xs text-red-500 bg-red-400/10 rounded-lg px-3 py-2">{error}</div>
        )}

        {actions.length === 0 ? (
          <div className="text-xs text-stone-400 px-3 py-3 glass-card rounded-xl">
            {error ? '加载失败，无法确认动作记录' : loaded ? '本对话暂无动作记录' : '加载中…'}
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
            {actions.map(a => {
              const badge = STATUS_BADGE[a.status] ?? { label: a.status, cls: 'bg-stone-400/15 text-stone-500' }
              return (
                <div key={a.actionId} className="flex items-center gap-2 px-3 py-1.5 glass-card rounded-lg text-[11px]">
                  <ActionStatusIcon status={a.status} />
                  <span className="font-medium text-stone-700 flex-1 truncate" title={a.actionId}>{a.actionType}</span>
                  <span className="text-stone-400" title={a.deviceId}>{a.deviceId.slice(0, 16)}</span>
                  <span className={`px-1.5 py-0.5 rounded-full font-medium ${badge.cls}`}>{badge.label}</span>
                  <span className="text-stone-400 w-24 text-right">{fmtTime(a.createdAt)}</span>
                </div>
              )
            })}
          </div>
        )}
        {actions.some(a => a.status === 'unknown' || a.status === 'interrupted') && (
          <p className="text-[10px] text-amber-600/80 mt-1.5 px-1">
            「不明」=结果不明禁止盲目重试；「中断」=确认未完成可安全重做（恢复摘要同口径）。
          </p>
        )}
        <p className="text-[10px] text-stone-400 mt-3 px-1">
          执行机由海獭按动作显式选择；机器列表与添加设备入口在「设置 → 执行机」。
        </p>
      </section>
    </Modal>
  )
}
