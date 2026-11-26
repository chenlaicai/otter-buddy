import { useCallback, useEffect, useState } from 'react'
import { Cpu, RefreshCw } from 'lucide-react'
import { ConnectorOnboardingPanel } from './ConnectorOnboardingPanel'

interface MachineEntry {
  id: string
  name: string
  online: boolean
  lastSeenAt: string | null
}

/** 系统级执行机管理：列表与添加设备均不复用对话级绑定语义。 */
export function ExecutionMachineSettings() {
  const [machines, setMachines] = useState<MachineEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const res = await fetch('/api/execution-machines', { credentials: 'same-origin' })
      if (res.status === 401) throw new Error('登录已过期，请刷新页面重新登录（HTTP 401）')
      if (!res.ok) throw new Error(`执行机列表加载失败（HTTP ${String(res.status)}）`)
      const body = await res.json() as { machines?: MachineEntry[] }
      setMachines(Array.isArray(body.machines) ? body.machines : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoaded(true)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  return (
    <section className="mb-8" data-testid="execution-machine-settings">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-stone-600 flex items-center gap-1.5">
          <Cpu size={15} className="text-otter-600" />执行机
        </h2>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={refreshing}
          className="text-stone-400 hover:text-stone-600 disabled:opacity-50"
          title="刷新执行机列表"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : undefined} />
        </button>
      </div>
      <p className="text-[11px] text-stone-400 mb-3">
        所有执行机都由 connector 注册；海獭按动作显式选择落点，对话不再绑定默认机器。
      </p>

      {error && <div role="alert" className="mb-2 text-xs text-red-500 bg-red-400/10 rounded-lg px-3 py-2">{error}</div>}

      <div className="space-y-1.5 mb-4">
        {machines.map(machine => (
          <div
            key={machine.id}
            data-testid={`execution-machine-${machine.id}`}
            className="flex items-center gap-2 px-3 py-2 rounded-xl border border-white/50 glass-card"
          >
            <Cpu size={14} className={machine.online ? 'text-teal-500' : 'text-stone-400'} />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-stone-700 truncate">{machine.name}</div>
              <div className="text-[10px] text-stone-400 font-mono truncate">{machine.id}</div>
            </div>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${machine.online ? 'bg-teal-400/15 text-teal-600' : 'bg-stone-400/15 text-stone-500'}`}>
              {machine.online ? '在线' : '离线'}
            </span>
            <span className="text-[10px] text-stone-400 w-32 text-right">
              {machine.lastSeenAt ? `最近在线 ${new Date(machine.lastSeenAt).toLocaleString()}` : '暂无上线记录'}
            </span>
          </div>
        ))}
        {loaded && !error && machines.length === 0 && (
          <div className="text-xs text-stone-400 px-3 py-3 glass-card rounded-xl">
            暂无已注册执行机。中枢启动后会自动注册本机 connector，也可在下方添加其他设备。
          </div>
        )}
        {!loaded && !error && <div className="text-xs text-stone-400 px-3 py-2">加载中…</div>}
      </div>

      <ConnectorOnboardingPanel />
    </section>
  )
}
