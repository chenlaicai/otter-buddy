import { useState, useEffect } from 'react'
import type { MatterDTO } from '../../../api/client'
import * as api from '../../../api/client'

/**
 * F20261006mtlp P1：待办板数据 hook（只读）。
 * 数据源 = GET /api/conversations/:id/matters（matters 表 open 清单）。
 * 轮询 30s（与 useScheduledTasks 同节奏——板上钉住的事项不需要秒级刷新，
 * 裁决动作走对话直复，獭代迁移后下轮轮询自然反映）。
 */
export function useMatters(conversationId: string | null) {
  const [matters, setMatters] = useState<MatterDTO[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!conversationId) return
    setLoading(true)
    api.listMatters(conversationId)
      .then(setMatters)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [conversationId])

  useEffect(() => {
    if (!conversationId) return
    const timer = setInterval(() => {
      api.listMatters(conversationId)
        .then(setMatters)
        .catch(() => {}) // 静默失败
    }, 30_000)
    return () => clearInterval(timer)
  }, [conversationId])

  return { matters, loading }
}
