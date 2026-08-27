import { useState, useEffect, useCallback } from 'react'
import { CheckCircle, XCircle, Loader, MessageSquare, Clock } from 'lucide-react'
import { Modal } from '../../components/Modal'
import type { LocalScheduledTaskExecution } from '../../lib/mappers'
import { mapExecutionDTO } from '../../lib/mappers'
import * as api from '../../api/client'

interface Props {
  taskId: string
  onClose: () => void
  onJumpToMessage?: (messageId: string) => void
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <CheckCircle size={14} className="text-green-500" />
    case 'failed':
      return <XCircle size={14} className="text-red-500" />
    case 'running':
      return <Loader size={14} className="text-blue-500 animate-spin" />
    default:
      return null
  }
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return ''
  try {
    const duration = new Date(end).getTime() - new Date(start).getTime()
    if (duration < 1000) return `${duration}ms`
    if (duration < 60000) return `${(duration / 1000).toFixed(1)}s`
    return `${Math.floor(duration / 60000)}m ${Math.floor((duration % 60000) / 1000)}s`
  } catch {
    return ''
  }
}

export function ExecutionHistoryModal({ taskId, onClose, onJumpToMessage }: Props) {
  const [executions, setExecutions] = useState<LocalScheduledTaskExecution[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [offset, setOffset] = useState(0)
  const limit = 20

  const loadExecutions = useCallback(async (newOffset: number) => {
    setLoading(true)
    try {
      const result = await api.listExecutions(taskId, { limit, offset: newOffset })
      const mapped = result.executions.map(mapExecutionDTO)
      if (newOffset === 0) {
        setExecutions(mapped)
      } else {
        setExecutions(prev => [...prev, ...mapped])
      }
      setTotal(result.total)
      setOffset(newOffset)
    } catch {
      // 静默失败
    } finally {
      setLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    loadExecutions(0)
  }, [taskId, loadExecutions])

  const hasMore = offset + limit < total

  return (
    <Modal title="执行历史" onClose={onClose} width="640px">
      <div className="max-h-[var(--modal-scroll-max-h)] overflow-y-auto">
        {loading && executions.length === 0 ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-16 bg-skeleton rounded-xl animate-pulse" />
            ))}
          </div>
        ) : executions.length === 0 ? (
          <div className="text-center text-stone-400 py-12">
            <Clock size={32} className="mx-auto mb-3 text-stone-300" />
            <div className="text-sm">暂无执行记录</div>
          </div>
        ) : (
          <div className="space-y-2">
            {executions.map(ex => (
              <div key={ex.id} className="glass-card p-3 rounded-xl">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <StatusIcon status={ex.status} />
                    <span className="text-sm text-stone-700">
                      {new Date(ex.triggeredAt).toLocaleString('zh-CN')}
                    </span>
                  </div>
                  {ex.messageId && onJumpToMessage && (
                    <button
                      onClick={() => onJumpToMessage(ex.messageId!)}
                      className="flex items-center gap-1 px-2 py-1 text-xs text-otter-600 hover:bg-otter-50 rounded-lg transition"
                    >
                      <MessageSquare size={12} />
                      查看消息
                    </button>
                  )}
                </div>

                {/* 耗时 */}
                {ex.completedAt && (
                  <div className="text-xs text-stone-400 mb-2">
                    耗时: {formatDuration(ex.triggeredAt, ex.completedAt)}
                  </div>
                )}

                {/* 错误信息 */}
                {ex.status === 'failed' && ex.errorMessage && (
                  <div className="text-xs text-red-500 bg-red-50 rounded-lg px-2 py-1.5">
                    {ex.errorMessage}
                  </div>
                )}

                {/* 状态标签 */}
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${
                    ex.status === 'completed'
                      ? 'bg-status-success text-green-700'
                      : ex.status === 'failed'
                        ? 'bg-status-error text-red-700'
                        : 'bg-status-running text-blue-700'
                  }`}>
                    {ex.status === 'completed' ? '成功' : ex.status === 'failed' ? '失败' : '执行中'}
                  </span>
                </div>
              </div>
            ))}

            {/* 加载更多 */}
            {hasMore && (
              <button
                onClick={() => loadExecutions(offset + limit)}
                disabled={loading}
                className="w-full py-2 text-sm text-stone-500 hover:text-stone-700 hover:bg-stone-50 rounded-lg transition"
              >
                {loading ? '加载中...' : '加载更多'}
              </button>
            )}

            {/* 总数提示 */}
            <div className="text-xs text-stone-400 text-center pt-2">
              共 {total} 条记录
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
