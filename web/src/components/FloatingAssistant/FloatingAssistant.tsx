import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../../api/client'
import { mapConversationDTO } from '../../lib/mappers'
import FloatingOtter from './FloatingOtter'
import AssistantPanel from './AssistantPanel'
import { useOtterMood, upsertGlobalConversation, useGlobalConversationSnapshot } from './global-conversation-store'
import { useFloatingOtter } from './use-floating-otter'

/**
 * F20260924wast：浮动獭宿主（AppLayout 挂载，全页面常驻）。
 * - 三态：全局轮询单例推断（冒泡 > 张望 > 睡觉）
 * - 开户（T2b）：无 web 助理对话时首次唤起自动创建（POST /api/conversations
 *   {kind:'web-assistant'}，后端幂等 + 人设注入）；双 tab 并发首唤由后端收敛
 * - 面板定位：獭位上方（右对齐），视口 clamp；獭靠上时改到下方
 * - enabled=false（assistant.web.enabled，DI 启动注入）：不挂载任何浮动元素
 *   ——降级入口 = 侧栏 web 助理对话分组
 */

export interface FloatingAssistantProps {
  /** assistant.web.enabled（settings DTO 下发；false = 完全不渲染） */
  enabled: boolean
}

/** 面板尺寸（AssistantPanel 380×520）——定位 clamp 基准 */
const PANEL_W = 380
const PANEL_H = 520

export function FloatingAssistant(props: FloatingAssistantProps) {
  const { enabled } = props
  const mood = useOtterMood()
  const { conversations } = useGlobalConversationSnapshot()
  const { open, setOpen, toggle, position, dragging, bindDrag } = useFloatingOtter()

  /** web 助理对话 id（null = 尚无） */
  const [webConvId, setWebConvId] = useState<string | null>(null)
  const [ensuring, setEnsuring] = useState(false)
  const [ensureError, setEnsureError] = useState<string | null>(null)
  const [initialDraft, setInitialDraft] = useState<string | null>(null)

  // 全局轮询数据中查找 web 助理对话（首个 active 的 kind=web-assistant）
  const polledConv = conversations.find(c => c.kind === 'web-assistant')
  useEffect(() => {
    if (polledConv) setWebConvId(prev => prev ?? polledConv.id)
  }, [polledConv])

  const unreadTotal = useMemo(
    () => conversations.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0),
    [conversations],
  )

  /** 首唤开户（幂等——后端 ensure 收敛；双 tab 并发由后端最早创建规则兜底） */
  const ensureConversation = useCallback(async () => {
    if (webConvId || ensuring) return
    setEnsuring(true)
    setEnsureError(null)
    try {
      const dto = await api.createConversation({ kind: 'web-assistant' } as never)
      const conv = mapConversationDTO(dto as Parameters<typeof mapConversationDTO>[0])
      upsertGlobalConversation(conv)
      setWebConvId(conv.id)
    } catch {
      setEnsureError('唤起助理失败，请重试')
    } finally {
      setEnsuring(false)
    }
  }, [webConvId, ensuring])

  // 首唤（open 且无对话且未在开户中）：自动开户
  useEffect(() => {
    if (open && !webConvId && !ensuring && !ensureError) void ensureConversation()
  }, [open, webConvId, ensuring, ensureError, ensureConversation])

  const handleToggle = useCallback(() => {
    toggle()
  }, [toggle])

  const handleQuickPrompt = useCallback((text: string) => {
    setInitialDraft(text)
    setOpen(true)
  }, [setOpen])

  /** 面板定位：獭位上方右对齐，视口 clamp（獭太靠上时改到下方）。
   *  Why 直接放 AssistantPanel：零尺寸 fixed 容器 + top/right 锚点会让子元素
   *  向右溢出视口（e2e 实测 x=1256 + 380 > 1280）——面板自带 fixed 定位才正确 */
  const panelStyle = useMemo(() => {
    const right = window.innerWidth - (position.x + 56)
    const above = position.y - 12 - PANEL_H > 0
    const top = above ? position.y - 12 - PANEL_H : position.y + 56 + 12
    const clampedRight = Math.max(8, Math.min(right, window.innerWidth - PANEL_W - 8))
    return { top, right: clampedRight, position: 'fixed' as const }
  }, [position])

  if (!enabled) return null

  return (
    <>
      <FloatingOtter
        mood={mood}
        unreadCount={unreadTotal}
        open={open}
        onToggle={handleToggle}
        onQuickPrompt={handleQuickPrompt}
        position={position}
        dragging={dragging}
        onPointerDown={bindDrag.onPointerDown}
      />
      {open && (
        <AssistantPanel
          style={panelStyle}
          conversationId={webConvId}
          ensuring={ensuring && !webConvId}
          ensureError={ensureError}
          onRetryEnsure={() => { setEnsureError(null); void ensureConversation() }}
          onClose={() => setOpen(false)}
          initialDraft={initialDraft}
          onDraftConsumed={() => setInitialDraft(null)}
        />
      )}
    </>
  )
}

export default FloatingAssistant
