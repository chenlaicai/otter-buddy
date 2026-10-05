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
  // #1132 检视处置（flush-on-switch）：pending 写入意图（debounce 窗口内未落盘的输入）
  // 单一真相源——切换对话时同步 flush 到旧 key，防三形态竞态：
  // A 快速切回读不到未落盘输入；B beforeunload 时序覆盖；C 新对话输入 clearTimeout
  // 把旧对话 pending timer 清掉（共享句柄）→ 旧输入永久丢失
  const pendingWriteRef = useRef<{ convId: string; text: string } | null>(null)

  // 同步 conversationId/draft 到 ref，确保 beforeunload 和 cleanup 闭包读到最新值
  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])
  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  // 加载草稿：组件挂载或 conversationId 变化时，从 localStorage 读取对应对话的草稿
  useEffect(() => {
    // #1132 检视处置（flush-on-switch）：切走前把旧对话 pending 输入同步落盘。
    // Why: debounce timer 的 300ms 窗口内切换对话，旧输入向未写 localStorage——
    // 不 flush 则：快速切回读不到（state/storage 分叉）、新对话输入 clearTimeout
    // 后永久丢失（timer 句柄共享）。flush 后 timer 消费掉，三形态同治。
    if (pendingWriteRef.current && pendingWriteRef.current.convId !== conversationId) {
      const pending = pendingWriteRef.current
      if (pending.text) {
        localStorage.setItem(`draft:${pending.convId}`, pending.text)
      } else {
        localStorage.removeItem(`draft:${pending.convId}`)
      }
      pendingWriteRef.current = null
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }

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
    // 同步更新 ref——与 clearDraft 同构，防止 effect cleanup 在 ref 同步前读到滞后旧值写回
    // Bug 场景：saveDraft('x') → saveDraft('') 时，cleanup 读到滞后的 'x' 写回 localStorage，清空内容复活
    draftRef.current = text

    // 清除之前的 debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    // 如果 conversationId 为 null，不保存草稿
    if (!conversationId) return

    // S1 修复：空串同步移除 key——防止 300ms debounce 窗口内卸载时旧值留存复活
    // Why: 手动清空语义=立即删除，不等 debounce；与 clearDraft 的 removeItem 同构
    if (!text) {
      localStorage.removeItem(`draft:${conversationId}`)
      // delta Δ1（fix-regression）：清空即终态，一并清掉 pending 写入意图——
      // 否则 saveDraft('x') 后窗口内清空，残留 {convId,'x'} 会被三条路径
      // （切换 flush / beforeunload / 卸载 cleanup）写回复活已删除的草稿
      pendingWriteRef.current = null
      return
    }

    // 设置新的 debounce timer
    // #1132 修复：闭包捕获 conversationId（timer 设置时的值），不用 conversationIdRef.current
    // Why: debounce 回调的语义是「text 与 conversationId 配对写入」——text 是本对话的输入，
    // id 必须是输入发生时的对话；读 ref 则 300ms 窗口内切换对话后 ref 已指向新对话，
    // 旧对话的文本串写进 draft:conv-2。与 beforeunload handler（读 ref 取「最新值」语义）
    // 刻意不同：那边是「页面关闭前把当前最新草稿存到当前最新对话」，两边是不同命题。
    // saveDraft 的 useCallback deps=[conversationId] 保证闭包内 conversationId 与调用时同步。
    pendingWriteRef.current = { convId: conversationId, text }
    debounceTimerRef.current = setTimeout(() => {
      localStorage.setItem(`draft:${conversationId}`, text)
      debounceTimerRef.current = null
      pendingWriteRef.current = null
    }, 300)
  }, [conversationId])

  // 清除草稿：发送成功后 localStorage.removeItem('draft:{convId}')
  const clearDraft = useCallback(() => {
    setDraft('')
    // 同步更新 ref——cleanup 闭包读 ref 而非 state，避免 ref 滞后导致 flush 覆盖
    draftRef.current = ''

    // 清除 debounce timer 与 pending 写入意图（发送即终态，不再落盘）
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    pendingWriteRef.current = null

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

      // 立即同步写入 localStorage（读 ref 而非闭包 draft——闭包在 deps=[] 下永远是初始值）
      const currentConversationId = conversationIdRef.current
      const currentDraft = draftRef.current
      // #1132 处置 B：pending 写入意图优先（它是用户最后确认中的输入）——直接落盘，
      // 避免「timer 还未触发 + draftRef 旧稿」的覆盖回滚形态
      const pending = pendingWriteRef.current
      if (pending) {
        if (pending.text) {
          localStorage.setItem(`draft:${pending.convId}`, pending.text)
        } else {
          localStorage.removeItem(`draft:${pending.convId}`)
        }
        // pending 已落盘，若与 currentConversationId 不同也一并列新对话最新 state
        if (currentConversationId && currentDraft && currentConversationId !== pending.convId) {
          localStorage.setItem(`draft:${currentConversationId}`, currentDraft)
        }
        return
      }
      if (currentConversationId && currentDraft) {
        localStorage.setItem(`draft:${currentConversationId}`, currentDraft)
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)

      // R5 修复：组件卸载时（SPA 导航）同步 flush 草稿到 localStorage
      // Why: beforeunload 只在浏览器关闭/刷新时触发，SPA 的 Link 导航不触发它
      // 组件卸载时 draft 可能还没写入（debounce 300ms 窗口内），必须同步 flush
      // 使用 draftRef.current 而非闭包中的 draft——闭包捕获的是 effect 注册时的值
      // deps=[]：cleanup 只在真正卸载时执行，不在 draft 每次变化时误写回
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
      // #1132 处置：卸载时 pending 写入意图优先落盘（与 beforeunload 同构）
      const pendingOnUnmount = pendingWriteRef.current
      if (pendingOnUnmount) {
        if (pendingOnUnmount.text) {
          localStorage.setItem(`draft:${pendingOnUnmount.convId}`, pendingOnUnmount.text)
        } else {
          localStorage.removeItem(`draft:${pendingOnUnmount.convId}`)
        }
        return
      }
      const currentConversationId = conversationIdRef.current
      const currentDraft = draftRef.current
      if (currentConversationId && currentDraft) {
        localStorage.setItem(`draft:${currentConversationId}`, currentDraft)
      }
    }
  }, [])

  return { draft, saveDraft, clearDraft }
}
