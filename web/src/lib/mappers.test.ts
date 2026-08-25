import { describe, it, expect } from 'vitest'
import { mapSessionDTO, mapOtterDTO, mapParticipantDTO } from './mappers'
import type { OtterSessionDTO, OtterDTO, ParticipantDTO } from '@contract/api'

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

describe('mapOtterDTO modelAlias（web-model-display）', () => {
  function makeOtterDTO(overrides: Partial<OtterDTO> = {}): OtterDTO {
    return {
      id: 'o1', name: '小獭', type: 'small', status: 'active',
      role: null, parentOtterId: null,
      createdAt: '2026-08-25T00:00:00Z', dissolvedAt: null,
      ...overrides,
    } as OtterDTO
  }

  it('DTO 带 modelAlias 时映射到 LocalOtter', () => {
    const o = mapOtterDTO(makeOtterDTO({ modelAlias: 'kimi' }))
    expect(o.modelAlias).toBe('kimi')
  })

  it('DTO 无 modelAlias 时 LocalOtter 不携带该字段（前端不渲染占位）', () => {
    const o = mapOtterDTO(makeOtterDTO())
    expect('modelAlias' in o).toBe(false)
  })
})

describe('mapParticipantDTO modelAlias（web-model-display）', () => {
  function makeParticipantDTO(overrides: Partial<ParticipantDTO> = {}): ParticipantDTO {
    return {
      id: 'p1', conversationId: 'c1', otterId: 'o1', otterName: '小獭',
      joinedAtTurnNumber: 1, leftAtTurnNumber: null,
      status: 'active', createdAt: '2026-08-25T00:00:00Z', leftAt: null,
      ...overrides,
    } as ParticipantDTO
  }

  it('DTO 带 modelAlias 时映射到 LocalOtter', () => {
    const o = mapParticipantDTO(makeParticipantDTO({ modelAlias: 'mimo' }))
    expect(o.modelAlias).toBe('mimo')
  })

  it('DTO 无 modelAlias 时 LocalOtter 不携带该字段', () => {
    const o = mapParticipantDTO(makeParticipantDTO())
    expect('modelAlias' in o).toBe(false)
  })
})
