import type { InvokeEventDTO } from '@contract/api'

/**
 * F20260910ctlv 收尾：invoke_events 按工具调用聚合（Session 弹窗展示粒度）。
 *
 * 问题：SDK 事件流对同一次工具调用产生三条记录——
 * 1. assistant_toolcall（tool_execution_start 快照：{name, arguments} 顶层字段）
 * 2. tool_result / speak（tool_execution_end：执行结果；speak 工具特殊归类为 speak 事件）
 * 3. assistant_toolcall（message_end 快照：{content: [{name, arguments}]}——name 在 content 内）
 * 不聚合则同一次调用在弹窗里出现 3 条，难读。
 *
 * 聚合规则（按 sequenceNum 时序单遍扫描）：
 * - 同名事件段（start 快照 → 结果 → message_end 快照）合为一个 ToolCallGroup：
 *   args 取首条 start 快照，result 取首条 tool_result
 * - speak 工具段折叠为单条 speak 事件（有 body，展示为「发言」）
 * - 新的 start 型 toolcall（顶层 name + arguments）开新段——多段 speak / 同名连续调用不串组
 * - assistant_text / error / 无法识别 name 的事件原样单项透传
 */
export type InvokeEventGroup =
  | { kind: 'toolcall'; name: string; args?: unknown; result?: unknown; resultError?: boolean; startSeq: number; endSeq: number | null }
  | { kind: 'single'; event: InvokeEventDTO }

/** 提取事件关联的工具名。两种形态：start 快照顶层 name；message_end 快照 content[].name */
function toolName(ev: InvokeEventDTO): string | null {
  const p = (ev.payload as Record<string, unknown> | null) ?? {}
  if (typeof p.name === 'string') return p.name
  if (Array.isArray(p.content)) {
    for (const c of p.content) {
      const r = c as Record<string, unknown>
      if (typeof r.name === 'string') return r.name
    }
  }
  return null
}

/** start 型 toolcall（顶层 name + arguments/input）——段内再次出现即开新段 */
function isStartTypeToolcall(ev: InvokeEventDTO): boolean {
  if (ev.eventType !== 'assistant_toolcall') return false
  const p = (ev.payload as Record<string, unknown> | null) ?? {}
  return typeof p.name === 'string' && (p.arguments !== undefined || p.input !== undefined)
}

function toolArgs(ev: InvokeEventDTO): unknown {
  const p = (ev.payload as Record<string, unknown> | null) ?? {}
  if (p.arguments !== undefined || p.input !== undefined) return p.arguments ?? p.input
  if (Array.isArray(p.content)) {
    const first = p.content[0] as Record<string, unknown> | undefined
    return first?.arguments ?? first?.input ?? undefined
  }
  return undefined
}

function resultPayload(ev: InvokeEventDTO): unknown {
  return (ev.payload as Record<string, unknown> | null)?.result ?? ev.payload
}

function resultIsError(ev: InvokeEventDTO): boolean {
  const r = resultPayload(ev)
  return typeof r === 'object' && r !== null && (r as { isError?: unknown }).isError === true
}

/** 事件是否属于「name 工具段」：同名 toolcall/tool_result，或 speak 工具的 speak 结果事件 */
function belongsToSegment(ev: InvokeEventDTO, name: string): boolean {
  const n = toolName(ev)
  if (n === name && (ev.eventType === 'assistant_toolcall' || ev.eventType === 'tool_result')) return true
  return name === 'speak' && ev.eventType === 'speak'
}

export function groupInvokeEvents(events: InvokeEventDTO[]): InvokeEventGroup[] {
  const groups: InvokeEventGroup[] = []
  let i = 0
  while (i < events.length) {
    const ev = events[i]
    const name = toolName(ev)

    if (name === null || ev.eventType === 'error' || ev.eventType === 'assistant_text') {
      groups.push({ kind: 'single', event: ev })
      i++
      continue
    }
    // 孤儿 tool_result（无前导 toolcall 开段）单项透传——防御乱序/裁剪的输入
    if (ev.eventType === 'tool_result') {
      groups.push({ kind: 'single', event: ev })
      i++
      continue
    }

    // ── 同名工具段扫描：[start] [result] [message_end 快照]（+ speak 的 speak 事件）──
    let j = i + 1
    let args: unknown
    let result: InvokeEventDTO | null = null
    let speakEvent: InvokeEventDTO | null = null
    args = ev.eventType === 'assistant_toolcall' ? toolArgs(ev) : undefined

    while (j < events.length) {
      const e = events[j]
      if (!belongsToSegment(e, name)) break
      // 段内出现新的 start 型同名调用 → 开新段（多段 speak / 同名连续调用边界）
      if (isStartTypeToolcall(e) && j > i) break
      if (e.eventType === 'assistant_toolcall' && args === undefined) args = toolArgs(e)
      if (e.eventType === 'tool_result' && !result) result = e
      if (e.eventType === 'speak') speakEvent = e
      j++
    }

    if (name === 'speak') {
      // speak 段折叠为单条「发言」条目（speak 事件带 body；缺失时回退首条 toolcall）
      groups.push({ kind: 'single', event: speakEvent ?? ev })
    } else {
      groups.push({
        kind: 'toolcall',
        name,
        args,
        result: result ? resultPayload(result) : undefined,
        resultError: result ? resultIsError(result) : false,
        startSeq: ev.sequenceNum,
        endSeq: result ? result.sequenceNum : null,
      })
    }
    i = j
  }
  return groups
}
