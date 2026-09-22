import { describe, it, expect } from 'vitest'
import {
  applyInvokeStart,
  applyInvokeTick,
  applyInvokeEnd,
  findOtterByInvokeId,
  isStreaming,
  fmtInvokeElapsed,
  fmtTokens,
  invokeBoundaryEntry,
  mergeInvokesFromServer,
  type InvokeStates,
  type ServerInvokeRecord,
} from './invoke-tracker'

/** F20260913ctlv Phase 4：invoke 状态追踪纯函数（右侧栏面板 + 时间线边界条目） */

const startPayload = (overrides: Partial<Parameters<typeof applyInvokeStart>[1]> = {}) => ({
  invokeId: 'inv-1',
  otterId: 'otter-a',
  otterName: '开发獭',
  conversationId: 'c1',
  startedAt: '2026-09-10T06:00:00Z',
  ...overrides,
})

describe('applyInvokeStart', () => {
  it('记录 running 状态', () => {
    const next = applyInvokeStart({}, startPayload())
    expect(next['otter-a']).toMatchObject({ invokeId: 'inv-1', status: 'running', otterName: '开发獭' })
    expect(isStreaming(next, 'otter-a')).toBe(true)
  })

  it('重放幂等：同 invokeId 同 startedAt 返回原引用', () => {
    const once = applyInvokeStart({}, startPayload())
    const twice = applyInvokeStart(once, startPayload())
    expect(twice).toBe(once)
  })

  it('新 invoke 覆盖旧状态（同獭第二次行动）', () => {
    let states = applyInvokeStart({}, startPayload())
    states = applyInvokeEnd(states, { invokeId: 'inv-1', otterId: 'otter-a', status: 'completed', endedAt: '2026-09-10T06:01:00Z' })
    states = applyInvokeStart(states, startPayload({ invokeId: 'inv-2', startedAt: '2026-09-10T07:00:00Z' }))
    expect(states['otter-a']).toMatchObject({ invokeId: 'inv-2', status: 'running' })
  })

  it('保留上轮 ctx：start 覆盖后仍携带上轮终态的 ctxWindowUsed/ctxMax（右栏休息中/行动间隙一致展示）', () => {
    let states = applyInvokeStart({}, startPayload())
    states = applyInvokeTick(states, { invokeId: 'inv-1', otterId: 'otter-a', conversationId: 'conv-1', ctxWindowUsed: 45200, ctxMax: 200000, toolCallCount: 8 })
    states = applyInvokeEnd(states, { invokeId: 'inv-1', otterId: 'otter-a', status: 'completed', endedAt: '2026-09-10T06:01:00Z' })
    states = applyInvokeStart(states, startPayload({ invokeId: 'inv-2', startedAt: '2026-09-10T07:00:00Z' }))
    expect(states['otter-a']).toMatchObject({ invokeId: 'inv-2', status: 'running', ctxWindowUsed: 45200, ctxMax: 200000 })
  })
})

describe('applyInvokeEnd', () => {
  it('记录终态快照（toolCallCount/tokenUsage）', () => {
    let states = applyInvokeStart({}, startPayload())
    states = applyInvokeEnd(states, {
      invokeId: 'inv-1', otterId: 'otter-a', status: 'completed',
      endedAt: '2026-09-10T06:02:00Z', toolCallCount: 7,
      tokenUsage: { input: 12000, output: 3400 },
    })
    expect(states['otter-a']).toMatchObject({
      status: 'completed', endedAt: '2026-09-10T06:02:00Z', toolCallCount: 7,
    })
    expect(isStreaming(states, 'otter-a')).toBe(false)
  })

  it('乱序防御：invokeId 不匹配时忽略（end 先于 start 到达）', () => {
    const states = applyInvokeStart({}, startPayload())
    const next = applyInvokeEnd(states, { invokeId: 'inv-other', otterId: 'otter-a', status: 'failed', endedAt: '2026-09-10T06:01:00Z' })
    expect(next).toBe(states)
  })

  it('无 start 记录时忽略', () => {
    expect(applyInvokeEnd({}, { invokeId: 'inv-x', otterId: 'otter-b', status: 'completed', endedAt: '2026-09-10T06:01:00Z' })).toEqual({})
  })
})

describe('applyInvokeTick（F20260914rtsp）', () => {
  it('running 中更新 ctx 与工具计数', () => {
    let states = applyInvokeStart({}, startPayload())
    states = applyInvokeTick(states, {
      invokeId: 'inv-1', otterId: 'otter-a', conversationId: 'conv-1',
      ctxWindowUsed: 45200, ctxMax: 200000, toolCallCount: 8,
    })
    expect(states['otter-a']).toMatchObject({ ctxWindowUsed: 45200, ctxMax: 200000, toolCallCount: 8, status: 'running' })
  })

  it('幂等：同值 tick 返回原引用', () => {
    let states = applyInvokeStart({}, startPayload())
    const tick = { invokeId: 'inv-1', otterId: 'otter-a', conversationId: 'conv-1', ctxWindowUsed: 45200, ctxMax: 200000, toolCallCount: 8 }
    states = applyInvokeTick(states, tick)
    expect(applyInvokeTick(states, tick)).toBe(states)
  })

  it('乱序防御：无 prev 或 invokeId 不匹配时忽略', () => {
    expect(applyInvokeTick({}, { invokeId: 'inv-x', otterId: 'otter-a', conversationId: 'c', ctxWindowUsed: 1, ctxMax: 2 })).toEqual({})
    const states = applyInvokeStart({}, startPayload())
    expect(applyInvokeTick(states, { invokeId: 'inv-other', otterId: 'otter-a', conversationId: 'c', ctxWindowUsed: 1, ctxMax: 2 })).toBe(states)
  })

  it('终态保留 tick 已写入的 ctx（休息中 · xx/xx 数据源）', () => {
    let states = applyInvokeStart({}, startPayload())
    states = applyInvokeTick(states, { invokeId: 'inv-1', otterId: 'otter-a', conversationId: 'conv-1', ctxWindowUsed: 45200, ctxMax: 200000, toolCallCount: 8 })
    states = applyInvokeEnd(states, { invokeId: 'inv-1', otterId: 'otter-a', status: 'completed', endedAt: '2026-09-10T06:02:00Z' })
    expect(states['otter-a']).toMatchObject({ status: 'completed', ctxWindowUsed: 45200, ctxMax: 200000 })
  })
})

describe('findOtterByInvokeId', () => {
  it('反查命中', () => {
    const states: InvokeStates = { a: { invokeId: 'i1', otterId: 'a', status: 'running', startedAt: '' } }
    expect(findOtterByInvokeId(states, 'i1')).toBe('a')
    expect(findOtterByInvokeId(states, 'nope')).toBeNull()
  })
})

/** F20260922rprf 检视发现 4：mergeInvokesFromServer（SSE 断连补偿合并） */
describe('mergeInvokesFromServer', () => {
  const serverInvoke = (overrides: Partial<ServerInvokeRecord> = {}): ServerInvokeRecord => ({
    id: 'inv-1', otterId: 'otter-a', status: 'completed',
    startedAt: '2026-09-22T06:00:00Z', endedAt: '2026-09-22T06:05:00Z',
    toolCallCount: 7, tokenUsageInput: 12000, tokenUsageOutput: 3400,
    ctxWindowUsed: 45200, ...overrides,
  })

  it('本地无 entry → 建立（含本地漏了 invoke.start 的场景）', () => {
    const next = mergeInvokesFromServer({}, [serverInvoke()])
    expect(next['otter-a']).toMatchObject({ invokeId: 'inv-1', status: 'completed', toolCallCount: 7, ctxWindowUsed: 45200 })
  })

  it('本地 running + 服务端同 invoke 已终态 → 收敛（断连丢 invoke.end 核心场景）', () => {
    const states = applyInvokeStart({}, startPayload({ invokeId: 'inv-1', startedAt: '2026-09-22T06:00:00Z' }))
    const next = mergeInvokesFromServer(states, [serverInvoke()])
    expect(next['otter-a']).toMatchObject({ invokeId: 'inv-1', status: 'completed', endedAt: '2026-09-22T06:05:00Z' })
    expect(isStreaming(next, 'otter-a')).toBe(false)
  })

  it('本地 running + 服务端同 invoke 仍 running → 跳过（无新信息）', () => {
    const states = applyInvokeStart({}, startPayload({ invokeId: 'inv-1' }))
    const next = mergeInvokesFromServer(states, [serverInvoke({ status: 'running', endedAt: null })])
    expect(next).toBe(states)
  })

  it('本地 running + 服务端已是更新 invoke → 覆盖（断连丢整轮 start+end）', () => {
    const states = applyInvokeStart({}, startPayload({ invokeId: 'inv-1' }))
    const next = mergeInvokesFromServer(states, [serverInvoke({ id: 'inv-2' })])
    expect(next['otter-a']).toMatchObject({ invokeId: 'inv-2', status: 'completed' })
  })

  it('本地已终态 → 跳过（本地已收敛，不回退）', () => {
    let states = applyInvokeStart({}, startPayload())
    states = applyInvokeEnd(states, { invokeId: 'inv-1', otterId: 'otter-a', status: 'completed', endedAt: '2026-09-22T06:05:00Z' })
    expect(mergeInvokesFromServer(states, [serverInvoke()])).toBe(states)
    expect(mergeInvokesFromServer(states, [serverInvoke({ id: 'inv-2', status: 'running', endedAt: null })])).toBe(states)
  })

  it('同獭多条记录只取最新（DESC 首次出现），后续旧记录跳过', () => {
    const next = mergeInvokesFromServer({}, [
      serverInvoke({ id: 'inv-2' }),
      serverInvoke({ id: 'inv-1', status: 'running', endedAt: null }),
    ])
    expect(next['otter-a']?.invokeId).toBe('inv-2')
  })

  it('无任何变更返回原引用（幂等，不驱动 re-render）', () => {
    let states = applyInvokeStart({}, startPayload())
    states = applyInvokeEnd(states, { invokeId: 'inv-1', otterId: 'otter-a', status: 'completed', endedAt: '2026-09-22T06:05:00Z' })
    expect(mergeInvokesFromServer(states, [])).toBe(states)
  })
})

describe('fmtInvokeElapsed / fmtTokens', () => {
  it('进行中按 startedAt 起算', () => {
    const s = { invokeId: 'i', otterId: 'a', status: 'running' as const, startedAt: '2026-09-10T06:00:00Z' }
    expect(fmtInvokeElapsed(s, Date.parse('2026-09-10T06:00:45Z'))).toBe('45s')
    expect(fmtInvokeElapsed(s, Date.parse('2026-09-10T06:05:30Z'))).toBe('5m30s')
  })
  it('终态按 endedAt - startedAt', () => {
    const s = { invokeId: 'i', otterId: 'a', status: 'completed' as const, startedAt: '2026-09-10T06:00:00Z', endedAt: '2026-09-10T06:01:20Z' }
    expect(fmtInvokeElapsed(s)).toBe('1m20s')
  })
  it('token 短格式', () => {
    expect(fmtTokens(undefined)).toBe('—')
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(1234)).toBe('1.2k')
  })
})

describe('invokeBoundaryEntry', () => {
  it('start 条目：entryType/invokeId/确定性 ID', () => {
    const e = invokeBoundaryEntry({ invokeId: 'inv-9', otterId: 'o', otterName: '小獭', kind: 'start', ts: '2026-09-10T06:00:00Z' })
    expect(e.id).toBe('invoke-inv-9-start')
    expect(e.entryType).toBe('invoke_start')
    expect(e.content).toBe('小獭 开始行动～')
    expect(e.invokeId).toBe('inv-9')
  })
  it('end 条目按终态给文案', () => {
    const base = { invokeId: 'inv-9', otterId: 'o', otterName: '小獭', ts: '2026-09-10T06:01:00Z' }
    expect(invokeBoundaryEntry({ ...base, kind: 'end', endStatus: 'completed' }).content).toBe('小獭 先休息一下～')
    expect(invokeBoundaryEntry({ ...base, kind: 'end', endStatus: 'failed' }).content).toBe('小獭 行动失败')
    expect(invokeBoundaryEntry({ ...base, kind: 'end', endStatus: 'aborted' }).content).toBe('小獭 被中断')
  })
})
