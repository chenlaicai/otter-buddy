import type { LocalMessage } from './mappers'

/**
 * F20260910ctlv：獭 invoke 状态追踪（右侧栏獭状态面板数据源）。
 * 红线：只根据 invoke.start / invoke.end SSE 事件维护状态——
 * entry.*（speak 粒度）不参与，避免流式 speak 事件驱动右栏高频 re-render；
 * toolCallCount/tokenUsage 仅 invoke.end 携带（终态快照，页面加载后刷新即恢复）。
 */

/** 单獭 invoke 状态（streaming = 有活跃 invoke） */
export interface OtterInvokeState {
  invokeId: string
  otterId: string
  otterName?: string
  status: 'running' | 'completed' | 'failed' | 'aborted'
  startedAt: string
  endedAt?: string
  /** invoke.end 携带（终态快照） */
  toolCallCount?: number
  tokenUsage?: { input: number; output: number }
}

/** invoke.start 事件负载（见 api-contract/sse/events.ts） */
export interface InvokeStartPayload {
  invokeId: string
  otterId: string
  otterName: string
  conversationId: string
  startedAt: string
}

/** invoke.end 事件负载 */
export interface InvokeEndPayload {
  invokeId: string
  otterId: string
  status: 'completed' | 'failed' | 'aborted'
  endedAt: string
  toolCallCount?: number
  tokenUsage?: { input: number; output: number }
}

export type InvokeStates = Record<string, OtterInvokeState>

/** invoke.start → 记 running 状态（同 invokeId 重放幂等：内容相同返回原引用） */
export function applyInvokeStart(states: InvokeStates, data: InvokeStartPayload): InvokeStates {
  const prev = states[data.otterId]
  const next: OtterInvokeState = {
    invokeId: data.invokeId,
    otterId: data.otterId,
    otterName: data.otterName,
    status: 'running',
    startedAt: data.startedAt,
  }
  if (prev && prev.invokeId === next.invokeId && prev.status === next.status && prev.startedAt === next.startedAt) {
    return states
  }
  return { ...states, [data.otterId]: next }
}

/** invoke.end → 记终态快照（completed/failed/aborted 保留，面板显示「刚结束」一轮信息） */
export function applyInvokeEnd(states: InvokeStates, data: InvokeEndPayload): InvokeStates {
  const prev = states[data.otterId]
  /** 乱序防御：end 先于 start 到达（重连重放）时，无 prev 或 invokeId 不匹配则忽略 */
  if (!prev || prev.invokeId !== data.invokeId) return states
  const next: OtterInvokeState = {
    ...prev,
    status: data.status,
    endedAt: data.endedAt,
    toolCallCount: data.toolCallCount,
    tokenUsage: data.tokenUsage,
  }
  if (prev.status === next.status && prev.endedAt === next.endedAt) return states
  return { ...states, [data.otterId]: next }
}

/** 该獭是否 streaming（有 running invoke） */
export function isStreaming(states: InvokeStates, otterId: string): boolean {
  return states[otterId]?.status === 'running'
}

/** invokeId → otterId 反查（invoke.end 事件实际发射不带 otterId，从状态表反查） */
export function findOtterByInvokeId(states: InvokeStates, invokeId: string): string | null {
  for (const [otterId, s] of Object.entries(states)) {
    if (s.invokeId === invokeId) return otterId
  }
  return null
}

/** 格式化耗时（进行中 = startedAt 起算；终态 = endedAt - startedAt） */
export function fmtInvokeElapsed(state: OtterInvokeState, nowMs?: number): string {
  const start = Date.parse(state.startedAt)
  if (Number.isNaN(start)) return '—'
  const end = state.status === 'running'
    ? (nowMs ?? Date.now())
    : (state.endedAt ? Date.parse(state.endedAt) : NaN)
  const ms = Number.isNaN(end) ? NaN : end - start
  if (Number.isNaN(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${s % 60}s` : `${Math.floor(m / 60)}h${m % 60}m`
}

/** token 用量短格式（1234 → 1.2k） */
export function fmtTokens(n: number | undefined | null): string {
  if (n == null) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** invoke 边界条目本地构造（invoke.start/end 事件驱动时间线插入，确定性 ID 幂等） */
export function invokeBoundaryEntry(opts: {
  invokeId: string
  otterId: string
  otterName?: string
  kind: 'start' | 'end'
  ts: string
  endStatus?: 'completed' | 'failed' | 'aborted'
}): LocalMessage {
  const name = opts.otterName || opts.otterId || '獭'
  const content = opts.kind === 'start'
    ? `${name} 开始行动～`
    : opts.endStatus === 'failed' ? `${name} 行动失败`
    : opts.endStatus === 'aborted' ? `${name} 被中断`
    : `${name} 先休息一下～`
  return {
    id: `invoke-${opts.invokeId}-${opts.kind}`,
    st: 'otter',
    si: opts.otterId,
    sn: opts.otterName,
    content,
    ts: opts.ts,
    dur: null,
    entryType: opts.kind === 'start' ? 'invoke_start' : 'invoke_end',
    invokeId: opts.invokeId,
  }
}
