import { describe, it, expect } from 'vitest'
import {
  applyInvokeStart,
  applyInvokeEnd,
  findOtterByInvokeId,
  isStreaming,
  fmtInvokeElapsed,
  fmtTokens,
  invokeBoundaryEntry,
  type InvokeStates,
} from './invoke-tracker'

/** F20260910ctlv Phase 4：invoke 状态追踪纯函数（右侧栏面板 + 时间线边界条目） */

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

describe('findOtterByInvokeId', () => {
  it('反查命中', () => {
    const states: InvokeStates = { a: { invokeId: 'i1', otterId: 'a', status: 'running', startedAt: '' } }
    expect(findOtterByInvokeId(states, 'i1')).toBe('a')
    expect(findOtterByInvokeId(states, 'nope')).toBeNull()
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
