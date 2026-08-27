import { describe, it, expect } from 'vitest'
import { shallowEqualOtters, mergeOttersIfChanged } from './shallow-equal-otters'
import type { LocalOtter } from './mappers'

function otter(overrides: Partial<LocalOtter> = {}): LocalOtter {
  return {
    id: 'o-1',
    name: '小獭',
    type: 'small',
    createdAt: '2026-08-27 09:00:00',
    ...overrides,
  }
}

describe('shallowEqualOtters（#502 轮询引用稳定）', () => {
  it('同引用返回 true', () => {
    const list = [otter()]
    expect(shallowEqualOtters(list, list)).toBe(true)
  })

  it('字段全等的不同对象返回 true（轮询重映射场景）', () => {
    const a = [otter({ role: { name: '布局', resp: [] }, modelAlias: 'kimi' })]
    const b = [otter({ role: { name: '布局', resp: [] }, modelAlias: 'kimi' })]
    expect(a[0]).not.toBe(b[0])
    expect(shallowEqualOtters(a, b)).toBe(true)
  })

  it('长度不同返回 false', () => {
    expect(shallowEqualOtters([otter()], [otter(), otter({ id: 'o-2' })])).toBe(false)
  })

  it.each([
    ['name', { name: '改名獭' }],
    ['type', { type: 'big' as const }],
    ['createdAt', { createdAt: '2026-08-27 10:00:00' }],
    ['modelAlias', { modelAlias: 'mimo' }],
  ])('字段 %s 变化返回 false', (_field, patch) => {
    expect(shallowEqualOtters([otter()], [otter(patch)])).toBe(false)
  })

  it('role.name 变化返回 false（role 对象引用变化但 name 相同仍 true）', () => {
    const a = [otter({ role: { name: '布局', resp: ['a'] } })]
    const b = [otter({ role: { name: '布局', resp: [] } })]
    expect(shallowEqualOtters(a, b)).toBe(true)
    const c = [otter({ role: { name: '样式', resp: ['a'] } })]
    expect(shallowEqualOtters(a, c)).toBe(false)
  })

  it('role 有无变化返回 false', () => {
    expect(shallowEqualOtters([otter()], [otter({ role: { name: 'x', resp: [] } })])).toBe(false)
  })

  it('顺序变化返回 false（参与者顺序即 UI 顺序）', () => {
    const a = otter({ id: 'o-1' })
    const b = otter({ id: 'o-2' })
    expect(shallowEqualOtters([a, b], [b, a])).toBe(false)
  })
})

describe('mergeOttersIfChanged（#502）', () => {
  it('内容未变时返回 prev（保引用，下游 memo 生效）', () => {
    const prev = { 'conv-1': [otter({ modelAlias: 'kimi' })] }
    const next = mergeOttersIfChanged(prev, 'conv-1', [otter({ modelAlias: 'kimi' })])
    expect(next).toBe(prev)
  })

  it('内容变化时返回新对象，且其他对话列表引用不变', () => {
    const other = [otter({ id: 'o-9' })]
    const prev = { 'conv-1': [otter()], 'conv-2': other }
    const next = mergeOttersIfChanged(prev, 'conv-1', [otter({ name: '新名' })])
    expect(next).not.toBe(prev)
    expect(next['conv-1'][0].name).toBe('新名')
    expect(next['conv-2']).toBe(other)
  })

  it('目标对话尚无记录时直接写入', () => {
    const prev: Record<string, LocalOtter[]> = {}
    const list = [otter()]
    const next = mergeOttersIfChanged(prev, 'conv-1', list)
    expect(next['conv-1']).toBe(list)
  })
})
