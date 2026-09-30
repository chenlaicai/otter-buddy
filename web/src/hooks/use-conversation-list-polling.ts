import { useEffect } from 'react'
import * as api from '../api/client'
import { mapConversationDTO, type LocalConversation } from '../lib/mappers'
import { mergeConversations } from '../lib/merge-conversations'

/**
 * 对话列表活动状态轮询（F20260805actv）：
 * - 每 5 秒刷新列表，仅在页面可见时运行（Page Visibility API）
 * - enabled=false（加载中/错误态）时不启动
 * - 合并策略见 merge-conversations.ts：服务端权威，本地 unreadCount 兜底
 *
 * F20260916lpsc：visibleIds 参数——传入时仅保留「轮询首屏 ∪ visibleIds」的对话，
 * 分页（加载更多）追加的后续页对话不被首屏轮询结果冲掉。不传则全量替换（旧行为）。
 */
export function useConversationListPolling(
  enabled: boolean,
  setConversations: React.Dispatch<React.SetStateAction<LocalConversation[]>>,
  visibleIds?: ReadonlySet<string>,
) {
  useEffect(() => {
    if (!enabled) return

    let timer: ReturnType<typeof setInterval> | null = null

    let fetching = false // 防重入：visible 立即刷新与 interval tick 撞车时跳过本次

    async function refresh() {
      if (fetching) return
      fetching = true
      try {
        const { items } = await api.listConversations()
        setConversations(prev => {
          const firstPage = items.map(mapConversationDTO)
          // Why: 分页追加的对话在首屏轮询结果中不存在——按 id 保留，
          // 新数据放前、保留的后续页放后，排序以服务端首屏为准
          const merged = visibleIds
            ? [...firstPage, ...prev.filter(p => visibleIds.has(p.id) && !firstPage.some(n => n.id === p.id))]
            : firstPage
          return mergeConversations(prev, merged)
        })
      } catch {
        console.error('Failed to poll conversations')
      } finally {
        fetching = false
      }
    }

    function startPolling() {
      if (timer) return // 防重入：重复 visible 事件不会双开 interval
      timer = setInterval(refresh, 5000)
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
        // F20260930zzr5：切回标签页立即刷一次，不等首个 5s tick——
        // 隐藏期间服务端状态已变（如 processing → awaiting_user），
        // 檅留的旧 badge 会误导「是否轮到我」的判断（issue #1249）
        refresh()
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
  }, [enabled, setConversations, visibleIds])
}
