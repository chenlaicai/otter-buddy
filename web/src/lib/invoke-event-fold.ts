import type { InvokeEventDTO } from '@contract/api'

/**
 * F20260914rtsp：invoke_events 展示层折叠（存储不动，渲染前归并）。
 *
 * 配对策略（方案 D 节 + 检视发现 5）：严格顺序遍历 + 同名 FIFO 队列。
 * Why FIFO 而非 Map 匹配：tool_result（tool_execution_end 落库）只有 name+result
 * 没有 arguments——无法用 name+arguments 配对；同工具连续调用时纯 name Map 匹配
 * 会把第一个结果配给第二个调用。顺序 FIFO 保证串行执行下配对正确。
 *
 * 归并规则：
 * 1. assistant_toolcall（tool_execution_start 落库，name+arguments）→ 入同名队尾
 * 2. tool_result（tool_execution_end 落库，name+result）→ 同名队头出队配对
 * 3. message_end 落库的 assistant_toolcall（LLM 请求块复述，无执行语义）→ 丢弃不配
 * 4. message_end 的 assistant_text → think 步
 * 5. speak 事件吸收同名待配对 start 步（见下「speak 吸收」）
 * 6. error 直通
 * 7. 孤儿容错：result 无 start → 独立 call 步；start 无 result（running/中断）→ 待定态 call 步
 *
 * speak 吸收（F20260914evdz）：speak 工具的 tool_execution_end 被 event-mapping 特判
 * 落库为 speak 事件（payload.body）而非 tool_result——start 步永无配对结果。若不吸收，
 * 一次发言渲染两条：假「执行中」speak 工具行 + 发言行，内容 100% 重复。吸收 = 移除
 * 假工具行、发言步 rawEventIds 合并溯源（点开仍可看原始分列）。
 *
 * 终态中断标记：invokeEnded=true 时，仍未配对的 start 步不再是「执行中」而是「已中断」
 * （灰点非转圈）——终态 invoke 里的 pending 是假象（回合早已结束）。 */

/** 折叠后的展示步 */
export type FoldedStep =
  | { kind: 'call'; name: string; args?: unknown; result?: unknown; isError?: boolean; pending: boolean; interrupted?: boolean; ts: string; tsEnd?: string; rawEventIds: string[] }
  | { kind: 'think'; text: string; ts: string; rawEventIds: string[] }
  | { kind: 'speak'; body: string; ts: string; rawEventIds: string[] }
  | { kind: 'error'; message: string; ts: string; rawEventIds: string[] }

/** 判定 assistant_toolcall 事件是否 message_end 快照（无执行语义）。
 *  快照 payload.content 是数组（LLM 请求块复述）；真实 start 落库 payload 是 {name, arguments}。 */
function isMessageEndSnapshot(ev: InvokeEventDTO): boolean {
  const p = ev.payload ?? {}
  return Array.isArray(p.content)
}

export function foldInvokeEvents(events: InvokeEventDTO[], opts?: { invokeEnded?: boolean }): FoldedStep[] {
  const steps: FoldedStep[] = []
  /** 同名待配对队列（FIFO） */
  const pendingCalls = new Map<string, Extract<FoldedStep, { kind: 'call' }>[]>()
  /** call 步的 raw 事件 id 溯源（含被丢弃的快照 id） */

  const enqueue = (step: Extract<FoldedStep, { kind: 'call' }>) => {
    const q = pendingCalls.get(step.name)
    if (q) q.push(step)
    else pendingCalls.set(step.name, [step])
    steps.push(step)
  }

  for (const ev of events) {
    switch (ev.eventType) {
      case 'assistant_toolcall': {
        if (isMessageEndSnapshot(ev)) break // 规则 3：message_end 快照丢弃（溯源 id 不丢——见 call 步 rawEventIds 注记）
        const p = ev.payload ?? {}
        enqueue({
          kind: 'call',
          name: String(p.name ?? 'unknown'),
          args: p.arguments,
          pending: true,
          ts: ev.createdAt,
          rawEventIds: [ev.id],
        })
        break
      }
      case 'tool_result': {
        const p = ev.payload ?? {}
        const name = String(p.name ?? 'unknown')
        const q = pendingCalls.get(name)
        const target = q?.shift()
        if (q && q.length === 0) pendingCalls.delete(name)
        if (!target) {
          // 规则 6：孤儿 result 独立成步
          steps.push({
            kind: 'call',
            name,
            result: p.result,
            pending: false,
            ts: ev.createdAt,
            rawEventIds: [ev.id],
          })
          break
        }
        // 配对成功：补 result + 终态
        target.result = p.result
        target.isError = isToolResultError(p.result)
        target.pending = false
        target.tsEnd = ev.createdAt
        target.rawEventIds.push(ev.id)
        break
      }
      case 'assistant_text': {
        const p = ev.payload ?? {}
        steps.push({ kind: 'think', text: extractText(p.content), ts: ev.createdAt, rawEventIds: [ev.id] })
        break
      }
      case 'speak': {
        const p = ev.payload ?? {}
        // 规则 5：吸收同名待配对 start 步（见文件头「speak 吸收」）——移除假工具行，
        // rawEventIds 合并保溯源；无 start（旧数据/异常序）则直通成发言步
        const q = pendingCalls.get('speak')
        const absorbed = q?.shift()
        if (q && q.length === 0) pendingCalls.delete('speak')
        if (absorbed) {
          const idx = steps.indexOf(absorbed)
          if (idx >= 0) steps.splice(idx, 1)
          steps.push({ kind: 'speak', body: String(p.body ?? ''), ts: ev.createdAt, rawEventIds: [...absorbed.rawEventIds, ev.id] })
        } else {
          steps.push({ kind: 'speak', body: String(p.body ?? ''), ts: ev.createdAt, rawEventIds: [ev.id] })
        }
        break
      }
      case 'error': {
        const p = ev.payload ?? {}
        steps.push({ kind: 'error', message: String(p.message ?? p.error ?? JSON.stringify(p)), ts: ev.createdAt, rawEventIds: [ev.id] })
        break
      }
      default:
        break
    }
  }
  // 终态中断标记：仍未配对的 start = 被中断（灰点「已中断」），不再假转圈
  if (opts?.invokeEnded) {
    for (const q of pendingCalls.values()) {
      for (const step of q) {
        step.pending = false
        step.interrupted = true
      }
    }
  }
  return steps
}

/** tool_result 错误判定：SDK 顶层 isError 硬编码 false 的历史包袱（agent-invoker recordToolEndMetric 注），
 *  按 result 形态防御性识别——string 以 [错误] 开头，或 object 含 isError===true */
function isToolResultError(result: unknown): boolean | undefined {
  if (typeof result === 'string') return result.startsWith('[错误]')
  if (result && typeof result === 'object' && 'isError' in (result as Record<string, unknown>)) {
    return (result as Record<string, unknown>).isError === true
  }
  return undefined
}

/** assistant_text payload.content → 纯文本（content 可能是块数组或字符串） */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(c => (typeof c === 'object' && c !== null && 'text' in (c as Record<string, unknown>) ? String((c as Record<string, unknown>).text ?? '') : String(c)))
      .join('')
  }
  return content == null ? '' : JSON.stringify(content)
}
