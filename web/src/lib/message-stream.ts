import type { LocalMessage } from './mappers'
import { nowTs } from './utils'

/**
 * 消息流纯函数（F20260724cwgn：统一渲染通道 + 轮询续看）。
 * 从 pages/conversation/index.tsx 提取，便于独立测试。
 */

/** 消息是否仍在生成中（刷新后用于轮询续看） */
export function isInFlight(m: LocalMessage): boolean {
  return m.st === 'otter' && (m.status === 'streaming' || m.status === 'speaking')
}

/** 消息是否处于终态（completed/failed/aborted 或 SSE 构造的终态消息） */
export function isTerminal(m: LocalMessage): boolean {
  return !isInFlight(m)
}

/** 按 id 更新或追加（轮询快照与 SSE 事件可能携带同一条消息，避免重复） */
export function upsertMessage(list: LocalMessage[], msg: LocalMessage): LocalMessage[] {
  const idx = list.findIndex(m => m.id === msg.id)
  if (idx === -1) return [...list, msg]
  const next = [...list]
  next[idx] = msg
  return next
}

/**
 * 按 seq 有序插入进行中消息（M5：append 位置必须等于服务端 sequence 时序）。
 * 规则：同 id 原位替换；否则插到第一个 seq 更大的消息之前；
 * 无 seq 的消息（tmp 乐观消息）不参与比较，自然保持在尾部之前插入的消息之后。
 */
export function insertBySeq(list: LocalMessage[], msg: LocalMessage): LocalMessage[] {
  const idx = list.findIndex(m => m.id === msg.id)
  if (idx !== -1) {
    const next = [...list]
    next[idx] = msg
    return next
  }
  if (msg.seq == null) return [...list, msg]
  const pos = list.findIndex(m => m.seq != null && m.seq > msg.seq!)
  if (pos === -1) return [...list, msg]
  return [...list.slice(0, pos), msg, ...list.slice(pos)]
}

/**
 * 终态消息 upsert（F20260805abpp 第四轮检视 S4-1）：与已有投影合并保留字段。
 * MPA 新页面的 live 状态为空，终态事件（complete/failed/aborted）构造的消息缺
 * events/seq/ts 等字段，整体替换会抹掉 DTO 快照已加载的投影（工具调用链、消息时间、
 * 时序锚点）。调用方把能确定的字段放进 msg（ts 传空串表示未知），已有投影回退补齐。
 */
export function upsertTerminalMessage(list: LocalMessage[], msg: LocalMessage): LocalMessage[] {
  const existing = list.find(m => m.id === msg.id)
  if (!existing) return upsertMessage(list, { ...msg, ts: msg.ts || nowTs() })
  const merged: LocalMessage = {
    ...msg,
    si: msg.si || existing.si,
    sn: msg.sn ?? existing.sn,
    ts: msg.ts || existing.ts,
    seq: msg.seq ?? existing.seq,
    events: msg.events ?? existing.events,
    ctx: msg.ctx ?? existing.ctx,
    ctxMax: msg.ctxMax ?? existing.ctxMax,
    turnId: msg.turnId ?? existing.turnId,
    src: msg.src ?? existing.src,
  }
  return upsertMessage(list, merged)
}

/**
 * 需要向服务器定点拉取终态的进行中消息（F20260805abpp）。
 * /after 增量游标是本地最后一条消息，结果严格在其之后——
 * 游标消息自身的 streaming→aborted/completed 状态迁移永远不在增量里，
 * 尤其 in-flight 恰好是最新消息时增量恒为空，定点拉取是唯一收敛路径。
 */
export function findStaleInFlight(list: LocalMessage[], newerIds: Set<string>): LocalMessage[] {
  return list.filter(m =>
    isInFlight(m) && !newerIds.has(m.id) && !m.id.startsWith('tmp-') && !m.id.startsWith('err-'))
}

/**
 * 轮询快照与本地列表合并：
 * - 过期快照不回退本地已终态的消息（响应在 message.complete 之前发出、之后到达）
 * - 双方均进行中时，保留 events 更长的一方（appendEvent 持久化滞后于 SSE，快照 events 可能瞬态更少）
 * - 保留未上服务器或不在快照窗口内的本地消息：tmp-/err- 前缀消息、进行中消息
 *   （limit=100 窗口外的进行中消息若被丢弃会导致轮询停止、状态永不更新）
 * - tmp 乐观消息按 st/si/content 多重集匹配去重（F6：连发两条相同内容不误判）
 * - 窗口外的终态消息允许被丢弃（与整页重载的窗口语义一致）
 */
export function mergeMessages(current: LocalMessage[], snapshot: LocalMessage[]): LocalMessage[] {
  const currentById = new Map(current.map(m => [m.id, m]))
  const snapshotIds = new Set(snapshot.map(m => m.id))
  const merged = snapshot.map(sm => {
    const local = currentById.get(sm.id)
    if (local && isTerminal(local) && isInFlight(sm)) return local
    if (local && isInFlight(local) && isInFlight(sm) && (local.events?.length ?? 0) > (sm.events?.length ?? 0)) {
      return { ...sm, events: local.events }
    }
    return sm
  })
  /** 多重集匹配：快照中每有一条等价消息只抵消一条 tmp */
  const snapshotCounts = new Map<string, number>()
  for (const sm of snapshot) {
    const key = `${sm.st}|${sm.si}|${sm.content}`
    snapshotCounts.set(key, (snapshotCounts.get(key) ?? 0) + 1)
  }
  const persisted = (tmp: LocalMessage): boolean => {
    const key = `${tmp.st}|${tmp.si}|${tmp.content}`
    const count = snapshotCounts.get(key) ?? 0
    if (count === 0) return false
    snapshotCounts.set(key, count - 1)
    return true
  }
  const isLocalOnly = (m: LocalMessage) =>
    (m.id.startsWith('tmp-') && !persisted(m)) || m.id.startsWith('err-') || isInFlight(m)
  return [...merged, ...current.filter(m => !snapshotIds.has(m.id) && isLocalOnly(m))]
}
