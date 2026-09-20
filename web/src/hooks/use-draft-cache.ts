import { useState, useEffect, useRef, useCallback } from 'react'

/**
 * 草稿缓存 Hook
 * 
 * 使用 localStorage 实现输入框草稿的持久化缓存。
 * 用户在对话 A 中输入未发送的内容，切换到对话 B 再切回对话 A 时，输入内容恢复。
 * 
 * 核心逻辑：
 * 1. 加载草稿：组件挂载或 conversationId 变化时，从 localStorage 读取对应对话的草稿
 * 2. 保存草稿：用户输入时 debounce 300ms 写入 localStorage（避免频繁写入）
 * 3. 清除草稿：发送成功后 localStorage.removeItem('draft:{convId}')
 * 4. 兜底保存：监听 beforeunload 事件，页面关闭或跳转前立即同步写入 localStorage 并取消 debounced 保存，避免重复写入
 * 5. 边界处理：当 conversationId 为 null 时（如新建对话、未选择对话），不保存草稿（因为无法关联到具体对话）
 */
export function useDraftCache(conversationId: string | null) {
  const [draft, setDraft] = useState('')
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const conversationIdRef = useRef(conversationId)
  // R5 修复：用 ref 追踪最新 draft 值，确保 cleanup 读到最新值而非闭包旧值
  const draftRef = useRef(draft)

  // 同步 conversationId/draft 到 ref，确保 beforeunload 和 cleanup 闭包读到最新值
  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])
  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  // 加载草稿：组件挂载或 conversationId 变化时，从 localStorage 读取对应对话的草稿
  useEffect(() => {
    if (conversationId) {
      const saved = localStorage.getItem(`draft:${conversationId}`)
      if (saved) {
        setDraft(saved)
      } else {
        setDraft('')
      }
    } else {
      setDraft('')
    }
  }, [conversationId])

  // 保存草稿：用户输入时 debounce 300ms 写入 localStorage
  const saveDraft = useCallback((text: string) => {
    setDraft(text)

    // 清除之前的 debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    // 如果 conversationId 为 null，不保存草稿
    if (!conversationId) return

    // 设置新的 debounce timer
    // Why: 使用 conversationIdRef.current 而非闭包中的 conversationId
    // 与 beforeunload handler 保持一致，避免 conversationId 变化时闭包捕获旧值
    debounceTimerRef.current = setTimeout(() => {
      const currentConversationId = conversationIdRef.current
      if (currentConversationId) {
        localStorage.setItem(`draft:${currentConversationId}`, text)
      }
      debounceTimerRef.current = null
    }, 300)
  }, [conversationId])

  // 清除草稿：发送成功后 localStorage.removeItem('draft:{convId}')
  const clearDraft = useCallback(() => {
    setDraft('')

    // 清除 debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }

    // 如果 conversationId 为 null，不操作 localStorage
    if (conversationId) {
      localStorage.removeItem(`draft:${conversationId}`)
    }
  }, [conversationId])

  // 兜底保存：监听 beforeunload 事件，页面关闭或跳转前立即同步写入 localStorage
  useEffect(() => {
    const handleBeforeUnload = () => {
      // 清除 debounce timer，避免重复写入
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }

      // 立即同步写入 localStorage
      const currentConversationId = conversationIdRef.current
      if (currentConversationId && draft) {
        localStorage.setItem(`draft:${currentConversationId}`, draft)
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)

      // R5 修复：组件卸载时（SPA 导航）同步 flush 草稿到 localStorage
      // Why: beforeunload 只在浏览器关闭/刷新时触发，SPA 的 Link 导航不触发它
      // 组件卸载时 draft 可能还没写入（debounce 300ms 窗口内），必须同步 flush
      // 使用 draftRef.current 而非闭包中的 draft——闭包捕获的是 effect 注册时的值
      // 检查 localStorage 是否已有该 key——clearDraft 会先 removeItem，避免覆盖
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
      const currentConversationId = conversationIdRef.current
      const currentDraft = draftRef.current
      if (currentConversationId && currentDraft && localStorage.getItem(`draft:${currentConversationId}`) !== null) {
        localStorage.setItem(`draft:${currentConversationId}`, currentDraft)
      }
    }
  }, [draft])

  return { draft, saveDraft, clearDraft }
}
