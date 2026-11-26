import { useState, useEffect, useCallback, useRef } from 'react'
import { Cpu, RefreshCw, CircleCheck, CircleX, CircleHelp, CirclePause, Clock } from 'lucide-react'
import { Modal } from '../../components/Modal'
import { fmtTime } from '../../lib/utils'
import { ConnectorOnboardingPanel } from './ConnectorOnboardingPanel'

/**
 * 执行机选择器 + 远程动作状态。
 *
 * - 选择器：全量设备列表（含离线——人要看得见才能决定切回）+ 当前对话机回显/切换
 *   （PUT；离线设备置灰不可选——重连后可切）
 * - 状态列表：该对话最近远程动作五态（requested/succeeded/failed/interrupted/unknown）
 * - 添加设备：登录态签发一次性码 + 当前中枢 CLI tarball 下载
 */

interface MachineEntry {
  id: string
  name: string
  online?: boolean
  lastSeenAt?: string
  /** 显式本机信号（共享投影 local 行恒携带；isDevice 判别不靠 online 字段缺省推断） */
  local?: boolean
}

interface RemoteActionEntry {
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
  onSwitched?: (machineId: string | null) => void
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

export function ExecutionMachineModal({ conversationId, onClose, onSwitched }: Props) {
  const [machines, setMachines] = useState<MachineEntry[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [actions, setActions] = useState<RemoteActionEntry[]>([])
  const [switching, setSwitching] = useState<string | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async () => {
    setError(null)
    try {
      const [mRes, cRes, aRes] = await Promise.all([
        fetch('/api/execution-machines', { credentials: 'same-origin' }),
        fetch(`/api/conversations/${conversationId}/execution-machine`, { credentials: 'same-origin' }),
        fetch(`/api/conversations/${conversationId}/remote-actions?limit=30`, { credentials: 'same-origin' }),
      ])
      // 非 OK 不再静默——区分鉴权失败与服务错误，避免 401 呈现误导性空态
      if (mRes.status === 401 || cRes.status === 401 || aRes.status === 401) {
        setError('登录已过期，请刷新页面重新登录（HTTP 401）')
        return
      }
      const failures: string[] = []
      if (mRes.ok) setMachines(((await mRes.json()) as { machines: MachineEntry[] }).machines)
      else failures.push(`设备列表 HTTP ${String(mRes.status)}`)
      if (cRes.ok) setCurrent(((await cRes.json()) as { machineId: string | null }).machineId)
      else failures.push(`当前执行机 HTTP ${String(cRes.status)}`)
      if (aRes.ok) setActions(((await aRes.json()) as { actions: RemoteActionEntry[] }).actions)
      else failures.push(`远程动作 HTTP ${String(aRes.status)}`)
      if (failures.length > 0) setError(`部分数据加载失败：${failures.join('；')}——列表可能不完整`)
    } catch {
      setError('数据加载失败（网络或服务不可用）')
    } finally {
      setLoaded(true)
    }
  }, [conversationId])

  useEffect(() => { void reload() }, [reload])

  // in-flight ref 守卫——React 重渲染前的极窄双击窗口不再重复发 PUT
  //（同目标幂等本无害，守卫彻底封死；state 式 disabled 保留供 UI 呈现）
  const switchingRef = useRef<string | null | undefined>(undefined)

  async function switchTo(machineId: string | null) {
    if (machineId === current) return
    if (switchingRef.current !== undefined) return
    switchingRef.current = machineId
    setSwitching(machineId)
    setError(null)
    try {
      const res = await fetch(`/api/conversations/${conversationId}/execution-machine`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ machineId }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `切换失败（${String(res.status)}）`)
      }
      setCurrent(machineId)
      onSwitched?.(machineId)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      switchingRef.current = undefined
      setSwitching(undefined)
    }
  }

  const isDevice = (m: MachineEntry) => m.local !== true

  return (
    <Modal isOpen onClose={onClose} title="执行机与远程动作" width="max-w-lg">
      <div className="space-y-4">
        <ConnectorOnboardingPanel />

        {error && (
          <div className="text-xs text-red-500 bg-red-400/10 rounded-lg px-3 py-2">{error}</div>
        )}

        {/* 机器选择器 */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-stone-600">对话执行机（六动作落点）</h3>
            <button onClick={() => void reload()} className="text-stone-400 hover:text-stone-600" title="刷新">
              <RefreshCw size={13} />
            </button>
          </div>
          <div className="space-y-1.5">
            {machines.map(m => {
              const selected = current === m.id || (current === null && m.id === 'local')
              const disabled = isDevice(m) && !m.online && !selected
              return (
                <button
                  key={m.id}
                  data-testid={`machine-option-${m.id}`}
                  onClick={() => void switchTo(m.id === 'local' ? null : m.id)}
                  disabled={disabled || switching !== undefined}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-left transition border ${
                    selected
                      ? 'border-otter-400/60 bg-otter-400/10'
                      : 'border-white/50 glass-card hover:bg-white/50'
                  } ${disabled ? 'opacity-45 cursor-not-allowed' : ''}`}
                >
                  <Cpu size={14} className={selected ? 'text-otter-600' : 'text-stone-400'} />
                  <span className="text-xs font-medium text-stone-700 flex-1">{m.name}</span>
                  {isDevice(m) ? (
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                        m.online ? 'bg-teal-400/15 text-teal-500' : 'bg-stone-400/15 text-stone-400'
                      }`}
                    >
                      {m.online ? '在线' : '离线'}
                    </span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-otter-400/15 text-otter-600">本机</span>
                  )}
                  {selected && <span className="text-[10px] text-otter-600">当前</span>}
                </button>
              )
            })}
            {loaded && machines.length === 0 && (
              <div className="text-xs text-stone-400 px-3 py-2">列表不可用</div>
            )}
          {machines.some(m => m.online === false) && (
              <p className="text-[10px] text-stone-400 px-1">
                离线设备置灰（重连后可切）；切「本机」=回默认。
              </p>
            )}
          </div>
          <p className="text-[10px] text-stone-400 mt-2 px-1">
            边界：workspace 动作与 SDK 文件/bash 按对话当前执行机路由；无对话的后台任务仍落中枢本机。
          </p>
        </section>

        {/* 远程动作状态 */}
        <section>
          <h3 className="text-xs font-semibold text-stone-600 mb-2">远程动作（最近 30 条）</h3>
          {actions.length === 0 ? (
            <div className="text-xs text-stone-400 px-3 py-3 glass-card rounded-xl">
              {error ? '加载失败，无法确认动作记录' : loaded ? '本对话暂无远程动作记录（本机执行的动作不在此列）' : '加载中…'}
            </div>
          ) : (
            <div className="max-h-56 overflow-y-auto space-y-1 pr-1">
              {actions.map(a => {
                const badge = STATUS_BADGE[a.status] ?? { label: a.status, cls: 'bg-stone-400/15 text-stone-500' }
                return (
                  <div key={a.actionId} className="flex items-center gap-2 px-3 py-1.5 glass-card rounded-lg text-[11px]">
                    <ActionStatusIcon status={a.status} />
                    <span className="font-medium text-stone-700 flex-1 truncate" title={a.actionId}>{a.actionType}</span>
                    <span className="text-stone-400">{a.deviceId.slice(0, 16)}</span>
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
        </section>
      </div>
    </Modal>
  )
}
