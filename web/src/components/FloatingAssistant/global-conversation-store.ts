import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LocalConversation } from '../../lib/mappers'

/**
 * F20260924wast：浮动獭全局单例轮询（M2 处置）。
 * use-conversation-list-polling 提升全局——App 层起一份 5s 轮询，
 * 对话列表页/对话页/浮动獭共用，避免多份轮询。
 *
 * 实现：模块级单例 store（订阅消费），App 层挂 <GlobalConversationPoller /> 组件
 * 驱动轮询生命周期（页面可见时运行，与原 hook 语义一致）。
 */

interface PollingStore {
  conversations: LocalConversation[]
  /** 版本号：每次轮询刷新成功递增——消费者按版本判断是否有新数据 */
  version: number
  listeners: Set<() => void>
}

const store: PollingStore = {
  conversations: [],
  version: 0,
  listeners: new Set(),
}

function emit() {
  store.version++
  store.listeners.forEach(l => l())
}

/** 非轮询路径写入（如首唤开户后立即注入新对话） */
export function setGlobalConversations(convs: LocalConversation[]) {
  store.conversations = convs
  emit()
}

/** 合并单条对话（开户后注入，不覆盖轮询已得的其他数据） */
export function upsertGlobalConversation(conv: LocalConversation) {
  const idx = store.conversations.findIndex(c => c.id === conv.id)
  if (idx === -1) { store.conversations = [conv, ...store.conversations] } else {
    store.conversations = [...store.conversations]
    store.conversations[idx] = conv
  }
  emit()
}

/** 读当前快照（非响应式——一次性读取场景） */
export function getGlobalConversations(): LocalConversation[] {
  return store.conversations
}

/** F20260924wast：三态推断（优先级写死：冒泡 > 张望 > 睡觉，SG1）。
 *  冒泡 = 任一对话有未读；张望 = 任一对话 activityStatus=processing；否则睡觉。
 *  已知失真由产品语义「大概状态」认领（方案取舍 2）。 */
export type OtterMood = 'sleep' | 'look' | 'bubble'

export function inferMood(convs: LocalConversation[]): OtterMood {
  if (convs.some(c => (c.unreadCount ?? 0) > 0)) return 'bubble'
  if (convs.some(c => c.activityStatus === 'processing')) return 'look'
  return 'sleep'
}

/** 消费全局轮询数据（响应式 hook） */
export function useGlobalConversationSnapshot(): { conversations: LocalConversation[]; version: number } {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force(v => v + 1)
    store.listeners.add(l)
    return () => { store.listeners.delete(l) }
  }, [])
  return { conversations: store.conversations, version: store.version }
}

/** 轮询引擎组件（App 层挂载一份） */
export function GlobalConversationPoller() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const tick = useCallback(async () => {
    try {
      const { listConversations } = await import('../../api/client')
      const { mapConversationDTO } = await import('../../lib/mappers')
      const { items } = await listConversations()
      // 服务端权威替换（三态数据源——merge 策略同 use-conversation-list-polling）
      store.conversations = items.map(mapConversationDTO)
      emit()
    } catch {
      // 轮询失败静默（下次再试）——与原 hook 行为一致
    }
  }, [])

  useEffect(() => {
    function start() {
      if (timerRef.current) return
      timerRef.current = setInterval(tick, 5000)
      void tick()
    }
    function stop() {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    }
    function handleVisibility() {
      if (document.hidden) stop(); else start()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    if (!document.hidden) start()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [tick])

  return null
}

/** 三态 hook（浮动獭专用，数据源 = 全局轮询单例） */
export function useOtterMood(): OtterMood {
  const { conversations } = useGlobalConversationSnapshot()
  return useMemo(() => inferMood(convsRef(conversations)), [conversations])
}

// conversations 引用稳定性兜底（emit 换新数组引用；直接用即可）
function convsRef(convs: LocalConversation[]): LocalConversation[] {
  return convs
}
