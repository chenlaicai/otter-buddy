import type { LocalMessage } from './mappers'

/**
 * F20260913ctlv：獭 invoke 状态追踪（右侧栏獭状态面板数据源）。
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
  /** F20260914rtsp：末次 LLM 往返 ctx 窗口占用（invoke.tick 携带；右栏 xx/xx 数据源） */
  ctxWindowUsed?: number
  /** F20260914rtsp：模型 ctx 上限（invoke.tick 携带） */
  ctxMax?: number
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

/** F20260914rtsp：invoke.tick 事件负载（见 api-contract/sse/events.ts；modelAlias 审视发现 2 删——发射端从未携带） */
export interface InvokeTickPayload {
  invokeId: string
  otterId: string
  conversationId: string
  /** 末次 LLM 往返 usage.totalTokens（窗口占用快照，含 cache） */
  ctxWindowUsed: number
  ctxMax: number
  toolCallCount?: number
}

export type InvokeStates = Record<string, OtterInvokeState>

/** F20260922rprf：服务端 invoke 记录（listInvokes 响应元素）的最小形状——
 *  与 api-contract InvokeDTO 结构兼容（此处独立声明避免 web→api-contract 深层 import）。 */
export interface ServerInvokeRecord {
  id: string
  otterId: string
  status: 'running' | 'completed' | 'failed' | 'aborted'
  startedAt: string
  endedAt: string | null
  toolCallCount: number
  tokenUsageInput: number | null
  tokenUsageOutput: number | null
  ctxWindowUsed: number | null
}

/** 服务端 invokes 合并进本地 invokeStates（拉取对账的写入语义，唯一真相源）。
 *  F20260928icmm 缓存模型（阶段1，弱合并退役）：服务端 invokes 表是权威数据源，
 *  同獭按 startedAt 最新者胜（同刻同 invokeId 时终态胜 running；同刻异 id 保守
 *  保持先到者；startedAt 不可解析时保守保持）；服务端更新即可覆盖本地任何旧状态
 *  （含本地终态——旧「本地终态即跳过」反向洞已随弱合并退役）；本地新于服务端
 *  （拉取竞态/SSE 实时先行）时本地保持，不回退。
 *  ctx 回填：服务端 ctx_window_used 为 null（新 invoke 首个 message_end 落库前）
 *  时回填本地上一轮值，与 applyInvokeStart「跨 invoke 保留 ctx」语义对齐。
 *  幂等：无任何变更时返回原引用（周期/重连/读点对账不驱动多余 re-render）。 */
export function mergeInvokesFromServer(states: InvokeStates, invokes: ServerInvokeRecord[]): InvokeStates {
  /** F20260928icmm 阶段1：缓存模型合并语义——服务端 invokes 表是权威数据源，同獭按
   *  startedAt 最新者胜（同刻比状态终态性：终态胜 running）；幂等：无变更返回原引用。
   *  弱合并（本地已有即跳过 / 本地终态即跳过）退役——它让切回对话后的对账拉取写不进状态，
   *  是右栏卡「运行中」四轮未愈的根因（联合排查 2026-09-28）。
   *  防回退保留：本地比服务端新（拉取竞态/SSE 实时先行）时本地保持，不会把右栏改旧。 */
  let next: InvokeStates | null = null
  const latest = new Map<string, ServerInvokeRecord>()
  for (const inv of invokes) {
    const seen = latest.get(inv.otterId)
    if (!seen || recordNewer(inv, seen)) latest.set(inv.otterId, inv)
  }
  for (const [otterId, inv] of latest) {
    const existing = (next ?? states)[otterId]
    if (existing && !recordNewer(inv, localAsRecord(existing))) continue
    if (next === null) next = { ...states }
    next[otterId] = {
      invokeId: inv.id,
      otterId: inv.otterId,
      otterName: existing?.otterName,
      status: inv.status,
      startedAt: inv.startedAt,
      ...(inv.endedAt && { endedAt: inv.endedAt }),
      toolCallCount: inv.toolCallCount,
      ...(inv.tokenUsageInput != null && inv.tokenUsageOutput != null && { tokenUsage: { input: inv.tokenUsageInput, output: inv.tokenUsageOutput } }),
      ...(inv.ctxWindowUsed != null
        ? { ctxWindowUsed: inv.ctxWindowUsed }
        // 检视建议 4（PR #1179）：服务端 ctx 尚未落库（新 invoke 首个 message_end 前）
        // 时回填本地上一轮值——与 applyInvokeStart 跨 invoke 保留 ctx 语义对齐
        // （「上下文只增不减」），避免右栏「行动中 · 45.2k/128k」闪成「—/—」。
        : (existing?.ctxWindowUsed != null && { ctxWindowUsed: existing.ctxWindowUsed })),
      ...(existing?.ctxMax != null && { ctxMax: existing.ctxMax }),
    }
  }
  return next ?? states
}

/** F20260928icmm：记录新旧比较——startedAt 新者胜；同刻同 invokeId 时终态胜 running
 *  （对账收敛本地幽灵 running）；无信息可判时保守返回 false（本地/先到者保持）。 */
function recordNewer(a: ServerInvokeRecord, b: ServerInvokeRecord): boolean {
  const ta = Date.parse(a.startedAt)
  const tb = Date.parse(b.startedAt)
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta > tb
  if (ta === tb && a.id === b.id) return a.status !== 'running' && b.status === 'running'
  return false
}

/** F20260928icmm：本地状态 → 服务端记录形状（供记录比较；无关字段置空）。 */
function localAsRecord(s: OtterInvokeState): ServerInvokeRecord {
  return {
    id: s.invokeId,
    otterId: s.otterId,
    status: s.status,
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? null,
    toolCallCount: 0,
    tokenUsageInput: null,
    tokenUsageOutput: null,
    ctxWindowUsed: null,
  }
}

/** invoke.start → 记 running 状态（同 invokeId 重放幂等：内容相同返回原引用）。
 *  保留上一轮终态的 ctxWindowUsed/ctxMax——ctx 表示「当前 session 的上下文占用」，
 *  新 invoke 刚启动尚未有首条 LLM 往返前，真实占用仍等于上轮末态（上下文只增不减）。 */
export function applyInvokeStart(states: InvokeStates, data: InvokeStartPayload): InvokeStates {
  const prev = states[data.otterId]
  const next: OtterInvokeState = {
    invokeId: data.invokeId,
    otterId: data.otterId,
    otterName: data.otterName,
    status: 'running',
    startedAt: data.startedAt,
    ...(prev?.ctxWindowUsed != null && { ctxWindowUsed: prev.ctxWindowUsed }),
    ...(prev?.ctxMax != null && { ctxMax: prev.ctxMax }),
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
    // F20260914rtsp：终态保留 tick 已写入的 ctx（「休息中 · xx/xx」数据源——上轮末次往返占用）
    ctxWindowUsed: prev.ctxWindowUsed,
    ctxMax: prev.ctxMax,
  }
  if (prev.status === next.status && prev.endedAt === next.endedAt) return states
  return { ...states, [data.otterId]: next }
}

/** 该獭是否 streaming（有 running invoke） */
export function isStreaming(states: InvokeStates, otterId: string): boolean {
  return states[otterId]?.status === 'running'
}

/** F20260914rtsp：invoke.tick → 更新 ctx/工具计数（running 期间实时化）。
 *  幂等：同 invokeId 同值返回原引用（避免高频 tick 触发无谓 re-render）。
 *  乱序防御：无 prev 或 invokeId 不匹配则忽略（重连重放场景）。 */
export function applyInvokeTick(states: InvokeStates, data: InvokeTickPayload): InvokeStates {
  const prev = states[data.otterId]
  if (!prev || prev.invokeId !== data.invokeId) return states
  const next: OtterInvokeState = {
    ...prev,
    toolCallCount: data.toolCallCount ?? prev.toolCallCount,
    ctxWindowUsed: data.ctxWindowUsed,
    ctxMax: data.ctxMax,
  }
  if (
    prev.toolCallCount === next.toolCallCount &&
    prev.ctxWindowUsed === next.ctxWindowUsed &&
    prev.ctxMax === next.ctxMax
  ) return states
  return { ...states, [data.otterId]: next }
}

/** F20260914rtsp：ctx 占用短格式（45200 → 45.2k；null/undefined → '—'） */
export function fmtCtx(n: number | undefined | null): string {
  if (n == null) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** F20260928icmm 阶段3退役：invokeId → otterId 反查（invoke.end 事件实际发射不带 otterId
 *  的前提已过时——唯一发射点 agent-invoker.ts 恒带 otterId；前端空串时早退与反查 miss
 *  行为等价，反查链无存在理由，已删） */

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
