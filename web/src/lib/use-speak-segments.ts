import { useRef, useCallback } from 'react'
import type { LocalMessage, LocalMessageSegment } from './mappers'

/**
 * 消息分段状态管理 hook（F-multi-speak-bubble）
 *
 * 职责：
 * - 管理流式期间的 segment 状态（按 segmentId upsert，天然幂等）
 * - 提供合并 segments 到消息的方法
 * - 提供清理方法（abort/complete 时调用）
 *
 * 设计决策：
 * - 使用 Map<messageId, Map<segmentId, LocalMessageSegment>> 结构
 * - upsert 语义保证重放安全（F20260819spyd 翻倍 bug 的土壤被消灭）
 * - 完成态以后端 segments 为准（complete 事件覆盖）
 */
export function useSpeakSegments() {
  // 流式期间的 segment 状态：messageId -> segmentId -> segment
  const liveSegmentsRef = useRef<Map<string, Map<string, LocalMessageSegment>>>(new Map())

  /** upsert 一个 segment（流式期间调用） */
  const upsertSegment = useCallback((messageId: string, segmentId: string, body: string, sequenceNum: number) => {
    const msgSegments = liveSegmentsRef.current.get(messageId) ?? new Map()
    msgSegments.set(segmentId, { id: segmentId, body, sequenceNum })
    liveSegmentsRef.current.set(messageId, msgSegments)
  }, [])

  /** 获取消息的 segments 数组（按 sequenceNum 排序） */
  const getSegments = useCallback((messageId: string): LocalMessageSegment[] => {
    const msgSegments = liveSegmentsRef.current.get(messageId)
    if (!msgSegments) return []
    return Array.from(msgSegments.values()).sort((a, b) => a.sequenceNum - b.sequenceNum)
  }, [])

  /** 清理消息的 segment 状态（complete/abort/failed 时调用） */
  const clearSegments = useCallback((messageId: string) => {
    liveSegmentsRef.current.delete(messageId)
  }, [])

  /** 将 segments 合并到消息对象 */
  const mergeSegmentsToMessage = useCallback((message: LocalMessage): LocalMessage => {
    // 如果消息已有 segments（来自 complete 事件），直接使用
    if (message.segments && message.segments.length > 0) {
      return message
    }
    // 否则从 liveSegments 获取
    const segments = getSegments(message.id)
    if (segments.length === 0) {
      return message
    }
    return { ...message, segments }
  }, [getSegments])

  return {
    upsertSegment,
    getSegments,
    clearSegments,
    mergeSegmentsToMessage,
  }
}
