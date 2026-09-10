import { describe, it, expect } from 'vitest'
import { mapSessionDTO, mapOtterDTO, mapParticipantDTO } from './mappers'
import type { LocalMessage } from './mappers'
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

  it('DTO 带 modelIsDefault 时映射到 LocalOtter（F20260908efmd）', () => {
    const o = mapOtterDTO(makeOtterDTO({ modelAlias: 'kimi', modelIsDefault: true }))
    expect(o.modelIsDefault).toBe(true)
  })

  it('旧 DTO（无 modelIsDefault 字段）兼容不炸，LocalOtter 不携带该字段', () => {
    const o = mapOtterDTO(makeOtterDTO({ modelAlias: 'kimi' }))
    expect(o.modelAlias).toBe('kimi')
    expect('modelIsDefault' in o).toBe(false)
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

  it('旧 ParticipantDTO（无 modelIsDefault 字段）兼容不炸（F20260908efmd）', () => {
    const o = mapParticipantDTO(makeParticipantDTO({ modelAlias: 'mimo' }))
    expect(o.modelAlias).toBe('mimo')
    expect('modelIsDefault' in o).toBe(false)
  })
})
/** F20260910ctlv：时间线条目类型（deriveEntryType 历史回退 + 居中条目文案） */
import { deriveEntryType, isCenteredEntry, centeredEntryText } from './mappers'

describe('deriveEntryType', () => {
  it('旧消息按 st 回退推导（无 entryType 字段）', () => {
    expect(deriveEntryType({ id: 'a', st: 'user', si: 'u', content: 'x', ts: '', dur: null })).toBe('user')
    expect(deriveEntryType({ id: 'b', st: 'system', si: 'sys', content: 'x', ts: '', dur: null })).toBe('system')
    expect(deriveEntryType({ id: 'c', st: 'otter', si: 'o', content: 'x', ts: '', dur: null })).toBe('speak')
  })
  it('entryType 显式携带时优先', () => {
    expect(deriveEntryType({ id: 'd', st: 'otter', si: 'o', content: '', ts: '', dur: null, entryType: 'invoke_start' })).toBe('invoke_start')
  })
})

describe('isCenteredEntry / centeredEntryText', () => {
  const base: LocalMessage = { id: 'e', st: 'otter', si: 'o1', content: '', ts: '', dur: null }
  it('invoke 边界/yield/system 居中，speak/user 气泡', () => {
    expect(isCenteredEntry({ ...base, entryType: 'invoke_start' })).toBe(true)
    expect(isCenteredEntry({ ...base, entryType: 'invoke_end' })).toBe(true)
    expect(isCenteredEntry({ ...base, entryType: 'yield' })).toBe(true)
    expect(isCenteredEntry({ ...base, entryType: 'speak' })).toBe(false)
    expect(isCenteredEntry({ ...base, st: 'user', entryType: 'user' })).toBe(false)
    expect(isCenteredEntry(base)).toBe(false) // 旧数据 speak 回退
  })
  it('yield 文案带目标名；body 非空时优先 body', () => {
    expect(centeredEntryText({ ...base, entryType: 'yield', yieldTargets: ['大獭', '小獭'] })).toBe('→ 交给 大獭、小獭')
    expect(centeredEntryText({ ...base, entryType: 'yield', content: '→ 交给 user', yieldTargets: ['user'] })).toBe('→ 交给 user')
    expect(centeredEntryText({ ...base, entryType: 'invoke_start', sn: '小獭' })).toBe('小獭 开始行动～')
  })
})
