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

/** F20260930s1x0 delta2（delta 复核发现：初版修复死链）：abort 409（假行动中）按服务端
 *  真实终态收敛。匹配集 = 快照 ∪ 当前 in-flight：
 *  - 快照命中（请求前 in-flight）——覆盖已被乐观置为 'aborted' 的气泡。初版只匹配
 *    isInFlight(current)，而入口在发请求前已乐观置终态，409 回来时恒零匹配，
 *    服务端真实终态被静默丢弃（completed 显示成「已中断」、failed 掩盖成 '[中断]'）。
 *  - 当前仍 in-flight——请求期间迟到的同 invoke 气泡（409 = invoke 已终态，不会再有
 *    invoke.end 收敛它）。
 *  content：保留已流出内容；乐观置位写入的 '[中断]' 占位在终态非 aborted 时按真实
 *  终态换文案（与 invoke.end 处理器同款：completed→''、aborted→'[中断]'、failed→'[未完成]'） */
export function settleInvokeToTerminal(
  list: LocalMessage[],
  invokeId: string,
  terminal: 'completed' | 'failed' | 'aborted',
  before: LocalMessage[],
): LocalMessage[] {
  const beforeById = new Map(before.map(m => [m.id, m]))
  const fallback = terminal === 'completed' ? '' : terminal === 'aborted' ? '[中断]' : '[未完成]'
  return list.map(m => {
    if (m.invokeId !== invokeId) return m
    const prev = beforeById.get(m.id)
    const wasInFlight = prev != null && isInFlight(prev)
    if (!isInFlight(m) && !wasInFlight) return m
    const content = m.content === '[中断]' && terminal !== 'aborted' ? fallback : m.content || fallback
    return { ...m, status: terminal, content }
  })
}

/** F20260930s1x0 delta（PR #1268 审视发现 1）：abort 失败（非 409）回滚乐观 aborted——
 *  仅回滚本次乐观置位的气泡：旧实现 status==='aborted' 误伤同 invokeId 的历史真实
 *  aborted 气泡，快照精确匹配本次乐观产物；回滚保留 content（乐观置时 m.content || '[中断]' 保留原内容，
 *  清空会丢弃已流出内容——不对称）。delta2（复核建议 3）：状态恢复快照原值
 *  （streaming/speaking 都还原，不再硬编码 streaming——丢 speaking 快照态）。 */
export function rollbackOptimisticAbort(
  list: LocalMessage[],
  invokeId: string,
  before: LocalMessage[],
): LocalMessage[] {
  const beforeById = new Map(before.map(m => [m.id, m]))
  return list.map(m => {
    const prev = beforeById.get(m.id)
    if (!prev || m.invokeId !== invokeId || !isInFlight(prev) || m.status !== 'aborted') return m
    return { ...m, status: prev.status, content: m.content === '[中断]' ? prev.content : m.content }
  })
}

/** F20260913ctlv：invoke 边界/yield/system 居中条目插入（无 seq，按 ts 时序）。
 *  从尾部向前找最后一个 ts <= msg.ts 的真实条目，插其后；越过 tmp-/err- 前缀的
 *  乐观/错误条目（它们无 seq 但时间上先于本次獭行动）；全部更新则插头部。
 *  幂等：同 id 已存在时原位替换 */
export function insertCenteredByTs(list: LocalMessage[], msg: LocalMessage): LocalMessage[] {
  const idx = list.findIndex(m => m.id === msg.id)
  if (idx !== -1) {
    const next = [...list]
    next[idx] = msg
    return next
  }
  const ts = msg.ts || ''
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    // F20260913ctlv 实测修复：tmp 乐观消息参与 ts 比较（不跳过）——用户刚发的 tmp 在列表尾，
    // 后续居中条目（invoke_start）ts 更晚，应插在 tmp 之后；旧逻辑 continue 跳过 tmp 后
    // 插到更早的条目前，导致「开始行动」排到用户发言上方。
    // ts 为空的 tmp 无时序语义，越过（与历史行为兼容）；err- 投影同越过。
    if (!m.ts || m.id.startsWith('err-')) continue
    if ((m.ts || '') <= ts) {
      return [...list.slice(0, i + 1), msg, ...list.slice(i + 1)]
    }
  }
  return [msg, ...list]
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
