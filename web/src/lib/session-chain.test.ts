import { describe, it, expect } from 'vitest'
import { sortSessionChain } from './session-chain'
import type { LocalOtterSession } from './mappers'

/** F20260805dmux：sortSessionChain 承载「第N世」计数口径契约（seed-011 引用），防口径回归 */

function makeSession(id: string, previousSessionId: string | null, overrides: Partial<LocalOtterSession> = {}): LocalOtterSession {
  return {
    id,
    otterId: 'o1',
    status: 'archived',
    previousSessionId,
    startedAt: '2026-08-05 10:00:00',
    archivedAt: null,
    archiveReason: null,
    isNegativeCase: false,
    summary: null,
    ...overrides,
  }
}

describe('sortSessionChain', () => {
  it('正常拉链：乱序输入按 previousSessionId 排成首世在前', () => {
    const s3 = makeSession('s3', 's2', { status: 'active' })
    const s1 = makeSession('s1', null)
    const s2 = makeSession('s2', 's1')
    expect(sortSessionChain([s3, s1, s2]).map(s => s.id)).toEqual(['s1', 's2', 's3'])
  })

  it('链外残留：拉链主线在前，残留按输入数组序附于链尾', () => {
    const s1 = makeSession('s1', null)
    const s2 = makeSession('s2', 's1', { status: 'active' })
    // 残留：prev 指向不存在的 session（链外）
    const orphan = makeSession('orphan', 'ghost')
    expect(sortSessionChain([orphan, s1, s2]).map(s => s.id)).toEqual(['s1', 's2', 'orphan'])
  })

  it('同 prev 分支：Map 后写覆盖先写，被覆盖者沦为残留附链尾', () => {
    const s1 = makeSession('s1', null)
    const branchA = makeSession('a', 's1')
    const branchB = makeSession('b', 's1', { status: 'active' })
    // b 后写覆盖 a → 主线 s1→b，a 作为残留附尾
    expect(sortSessionChain([s1, branchA, branchB]).map(s => s.id)).toEqual(['s1', 'b', 'a'])
  })

  it('空数组返回空数组', () => {
    expect(sortSessionChain([])).toEqual([])
  })

  it('首世缺失（无 prev=null）：全部沦为残留，不丢元素', () => {
    const s1 = makeSession('s1', 's0')
    const s2 = makeSession('s2', 's1')
    const result = sortSessionChain([s1, s2])
    expect(result).toHaveLength(2)
    expect(result.map(s => s.id)).toEqual(['s1', 's2'])
  })

  it('previousSessionId 为 undefined 时归一化为 null（首世不丢失）', () => {
    const s1 = makeSession('s1', undefined as unknown as null)
    const s2 = makeSession('s2', 's1', { status: 'active' })
    expect(sortSessionChain([s2, s1]).map(s => s.id)).toEqual(['s1', 's2'])
  })

  it('复用原对象引用（RightPanel indexOf 口径依赖）', () => {
    const s1 = makeSession('s1', null)
    const s2 = makeSession('s2', 's1', { status: 'active' })
    const result = sortSessionChain([s2, s1])
    expect(result[0]).toBe(s1)
    expect(result[1]).toBe(s2)
  })
})
