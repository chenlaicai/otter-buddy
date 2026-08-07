import type { LocalConversation } from './mappers'

/**
 * 轮询结果合并策略（F20260805actv）：
 * - 以服务端列表为准：新增对话出现、归档对话消失、排序、activityStatus/lastMessagePreview 等实时字段
 * - unreadCount 服务端权威（按 last_read_message_seq 实时计算）；
 *   本地值仅在服务端字段缺失时兜底（如增量接口未返回该字段）
 */
export function mergeConversations(
  prev: LocalConversation[],
  next: LocalConversation[],
): LocalConversation[] {
  return next.map(n => {
    const existing = prev.find(p => p.id === n.id)
    return existing ? { ...n, unreadCount: n.unreadCount ?? existing.unreadCount } : n
  })
}
