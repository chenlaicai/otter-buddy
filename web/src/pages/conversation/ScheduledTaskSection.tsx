import { Clock, Play, History, Edit, Trash, AlertCircle } from 'lucide-react'
import type { LocalScheduledTask } from '../../lib/mappers'

interface Props {
  tasks: LocalScheduledTask[]
  onToggle: (taskId: string) => void
  onEdit: (task: LocalScheduledTask) => void
  onDelete: (taskId: string) => void
  onTrigger: (taskId: string) => void
  onViewHistory: (taskId: string) => void
}

function formatNextTrigger(isoString: string | null): string {
  if (!isoString) return ''
  try {
    const date = new Date(isoString)
    const now = new Date()
    const diff = date.getTime() - now.getTime()
    if (diff < 0) return '即将触发'
    if (diff < 60000) return '不到 1 分钟'
    if (diff < 3600000) return `约 ${Math.floor(diff / 60000)} 分钟`
    if (diff < 86400000) return `约 ${Math.floor(diff / 3600000)} 小时`
    return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
  } catch {
    return ''
  }
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { bg: string; text: string; label: string }> = {
    active: { bg: 'bg-status-success', text: 'text-green-700', label: '运行中' },
    disabled: { bg: 'bg-skeleton', text: 'text-stone-500', label: '已暂停' },
    error: { bg: 'bg-status-error', text: 'text-red-700', label: '错误' },
  }
  const c = config[status] || config.disabled
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${c.bg} ${c.text}`}>
      {status === 'error' && <AlertCircle size={10} />}
      {c.label}
    </span>
  )
}

export function ScheduledTaskSection({ tasks, onToggle, onEdit, onDelete, onTrigger, onViewHistory }: Props) {
  if (tasks.length === 0) {
    return (
      <div className="text-center text-stone-400 py-6 text-sm">
        暂无定时任务
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {tasks.map(task => (
        <div key={task.id} className="glass-card p-3 rounded-xl">
          {/* 头部：名称 + 状态 */}
          <div className="flex items-center justify-between mb-2">
            <span className="font-medium text-sm text-stone-700 truncate flex-1 mr-2">{task.name}</span>
            <button
              onClick={() => onToggle(task.id)}
              className={`relative w-9 h-5 rounded-full transition-colors ${
                task.status === 'active' ? 'bg-green-500' : 'bg-stone-300'
              }`}
              title={task.status === 'active' ? '点击暂停' : '点击启用'}
            >
              <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                task.status === 'active' ? 'translate-x-4' : 'translate-x-0.5'
              }`} />
            </button>
          </div>

          {/* 状态标签 */}
          <div className="mb-2">
            <StatusBadge status={task.status} />
          </div>

          {/* 调度信息 */}
          <div className="flex items-center gap-1.5 text-xs text-stone-500 mb-1">
            <Clock size={12} />
            {task.scheduleType === 'once' ? (
              <>
                <span className="px-1.5 py-0.5 rounded-full bg-status-running text-blue-700 text-[10px] font-medium">一次性</span>
                {task.triggerAt ? (
                  <span>{new Date(task.triggerAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })}</span>
                ) : (
                  <span className="text-stone-400">未设置触发时间</span>
                )}
              </>
            ) : (
              <>
                <span className="font-mono">{task.cron}</span>
                <span className="text-stone-400">({task.timezone})</span>
              </>
            )}
          </div>

          {/* 下次触发时间 */}
          {task.nextTriggerAt && (
            <div className="text-xs text-stone-400 mb-2">
              下次: {formatNextTrigger(task.nextTriggerAt)}
            </div>
          )}

          {/* 连续失败提示 */}
          {task.consecutiveFailures > 0 && (
            <div className="text-xs text-red-500 mb-2 flex items-center gap-1">
              <AlertCircle size={10} />
              连续失败 {task.consecutiveFailures} 次
            </div>
          )}

          {/* 消息内容预览 */}
          <div className="text-xs text-stone-600 mb-3 line-clamp-2 bg-glass-surface rounded-lg px-2 py-1.5">
            {task.body}
          </div>

          {/* 特性标签 */}
          {task.restartBeforeInvoke && (
            <div className="text-xs text-otter-600 mb-2 flex items-center gap-1">
              <span className="px-1.5 py-0.5 rounded-full bg-otter-100 text-otter-700 text-[10px] font-medium">重启獭生</span>
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => onTrigger(task.id)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-stone-600 hover:text-green-600 hover:bg-green-50 rounded-lg transition"
              title="手动触发"
              disabled={task.status !== 'active'}
            >
              <Play size={12} />
              <span>触发</span>
            </button>
            <button
              onClick={() => onViewHistory(task.id)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-stone-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition"
              title="执行历史"
            >
              <History size={12} />
              <span>历史</span>
            </button>
            <button
              onClick={() => onEdit(task)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-stone-600 hover:text-otter-600 hover:bg-otter-50 rounded-lg transition"
              title="编辑"
            >
              <Edit size={12} />
              <span>编辑</span>
            </button>
            <button
              onClick={() => onDelete(task.id)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-stone-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition ml-auto"
              title="删除"
            >
              <Trash size={12} />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
