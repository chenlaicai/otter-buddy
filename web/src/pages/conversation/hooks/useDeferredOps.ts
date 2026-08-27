import { useCallback, useRef } from 'react'

/**
 * F20260827scrf2：弹窗期延迟操作队列。
 *
 * 背景：scrim 的 backdrop-filter 重算由背后像素变化驱动（F20260825scrf 根因），
 * 上轮冻结了 SSE batch/双轮询/shimmer，但 SSE 回调里直接 setState 的路径
 * （参与者 upsert、onDone 刷新、新消息徽标）绕过了全部 gate——多獭流式场景
 * 每 turn 都触发，成为第五变化源。本 hook 把这类 setState 闭包统一收口：
 *
 * - isDeferred() 为真（弹窗打开）：操作进队列，不执行、不渲染
 * - flush()：一次性按序重放（全部为函数式 setState，重放安全）
 *
 * 注意：闭包捕获的是入队时刻的快照（如 added、isAtBottom），重放语义 = 到达时刻语义。
 */
export function useDeferredOps(isDeferred: () => boolean) {
  const pendingRef = useRef<Array<() => void>>([])
  const isDeferredRef = useRef(isDeferred)
  isDeferredRef.current = isDeferred

  const runOrDefer = useCallback((op: () => void) => {
    if (isDeferredRef.current()) {
      pendingRef.current.push(op)
    } else {
      op()
    }
  }, [])

  const flush = useCallback(() => {
    if (pendingRef.current.length === 0) return
    const ops = pendingRef.current
    pendingRef.current = []
    for (const op of ops) op()
  }, [])

  return { runOrDefer, flush }
}
