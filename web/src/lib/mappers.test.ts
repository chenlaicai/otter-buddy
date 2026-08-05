import { describe, it, expect } from 'vitest'
import { mapSessionDTO } from './mappers'
import type { OtterSessionDTO } from '@contract/api'

function makeDTO(overrides: Partial<OtterSessionDTO> = {}): OtterSessionDTO {
  return {
    id: 's1',
    otterId: 'o1',
    status: 'active',
    previousSessionId: null,
    startedAt: '2026-08-05T00:00:00Z',
    archivedAt: null,
    archiveReason: null,
    isNegativeCase: false,
    summary: null,
    ...overrides,
  } as OtterSessionDTO
}

describe('mapSessionDTO (F20260805rsto)', () => {
  it('保留 previousSessionId（链式展示依赖）', () => {
    const s = mapSessionDTO(makeDTO({ previousSessionId: 'prev-1' }))
    expect(s.previousSessionId).toBe('prev-1')
  })

  it('restarted 状态原样透传，不退化为 archived', () => {
    const s = mapSessionDTO(makeDTO({ status: 'restarted' as OtterSessionDTO['status'] }))
    expect(s.status).toBe('restarted')
  })

  it('summary 透传（active 行前情标注依赖）', () => {
    const s = mapSessionDTO(makeDTO({ summary: '前情' }))
    expect(s.summary).toBe('前情')
  })
})
