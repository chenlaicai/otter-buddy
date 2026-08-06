import { useEffect } from 'react'
import * as api from '../api/client'
import { mapConversationDTO, type LocalConversation } from '../lib/mappers'
import { mergeConversations } from '../lib/merge-conversations'

/**
 * 对话列表活动状态轮询（F20260805actv）：
 * - 每 5 秒刷新列表，仅在页面可见时运行（Page Visibility API）
 * - enabled=false（加载中/错误态）时不启动
 * - 合并策略见 merge-conversations.ts：服务端权威，本地 unreadCount 兜底
 */
export function useConversationListPolling(
  enabled: boolean,
  setConversations: React.Dispatch<React.SetStateAction<LocalConversation[]>>,
) {
  useEffect(() => {
    if (!enabled) return

    let timer: ReturnType<typeof setInterval> | null = null

    function startPolling() {
      if (timer) return // 防重入：重复 visible 事件不会双开 interval
      timer = setInterval(async () => {
        try {
          const dtos = await api.listConversations()
          setConversations(prev => mergeConversations(prev, dtos.map(mapConversationDTO)))
        } catch {
          console.error('Failed to poll conversations')
        }
      }, 5000)
    }

    function stopPolling() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }

    function handleVisibility() {
      if (document.hidden) {
        stopPolling()
      } else {
        startPolling()
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    if (!document.hidden) {
      startPolling()
    }

    return () => {
      stopPolling()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [enabled, setConversations])
}
