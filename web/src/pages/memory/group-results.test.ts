/**
 * F20260928mrui：记忆召回结果结构化分组单测。
 * 覆盖：doc 聚合（chunk 归拢 + summary 并列）/ conversation 时间线 / 独立条目 /
 * 邻域条目归组与排序豁免 / 组间相关性降序。
 */
import { describe, it, expect } from 'vitest'
import { groupResults, resolveCreatedAfter } from './group-results'
import type { MemoryEntryDTO } from '@contract/api'

function entry(over: Partial<MemoryEntryDTO> & Pick<MemoryEntryDTO, 'id' | 'contentType'>): MemoryEntryDTO {
  return {
    layer: 'document',
    sourceId: 'doc1',
    sourceTable: 'features',
    conversationId: null,
    granularity: 'fine',
    content: `content-${over.id}`,
    metadata: null,
    createdAt: '2026-09-01T00:00:00Z',
    ...over,
  } as MemoryEntryDTO
}

describe('groupResults', () => {
  it('同文档多 chunk 归拢为一组，组内按 chunk_index 升序', () => {
    const groups = groupResults([
      entry({ id: 'c2', contentType: 'feature_chunk', metadata: { chunk_index: 2, doc_title: '记忆召回界面' } }),
      entry({ id: 'c0', contentType: 'feature_chunk', metadata: { chunk_index: 0 } }),
      entry({ id: 'c1', contentType: 'feature_chunk', metadata: { chunk_index: 1 } }),
    ])
    expect(groups).toHaveLength(1)
    const g = groups[0]
    expect(g.kind).toBe('doc')
    if (g.kind === 'doc') {
      expect(g.docTitle).toBe('记忆召回界面')
      expect(g.docEntry).toBeNull()
      expect(g.items.map(e => e.id)).toEqual(['c0', 'c1', 'c2'])
    }
  })

  it('doc summary 与 chunk 并列：summary 进 docEntry 槽位不挤占 items', () => {
    const groups = groupResults([
      entry({ id: 's1', contentType: 'feature', score: 0.8 }),
      entry({ id: 'c1', contentType: 'feature_chunk', metadata: { chunk_index: 1 }, score: 0.5 }),
    ])
    expect(groups).toHaveLength(1)
    const g = groups[0]
    if (g.kind === 'doc') {
      expect(g.docEntry?.id).toBe('s1')
      expect(g.items.map(e => e.id)).toEqual(['c1'])
    }
  })

  it('message 按 conversation 聚合成时间线（createdAt 升序）', () => {
    const groups = groupResults([
      entry({ id: 'm2', contentType: 'message', conversationId: 'convA', createdAt: '2026-09-03T10:00:00Z', sourceId: 's', sourceTable: 'messages' }),
      entry({ id: 'm1', contentType: 'message', conversationId: 'convA', createdAt: '2026-09-02T09:00:00Z', sourceId: 's', sourceTable: 'messages' }),
      entry({ id: 'm3', contentType: 'message', conversationId: 'convB', createdAt: '2026-09-04T09:00:00Z', sourceId: 's', sourceTable: 'messages' }),
    ])
    expect(groups).toHaveLength(2)
    const convA = groups.find(g => g.kind === 'conversation' && g.conversationId === 'convA')
    expect(convA).toBeDefined()
    if (convA?.kind === 'conversation') {
      expect(convA.items.map(e => e.id)).toEqual(['m1', 'm2'])
    }
  })

  it('fact/linked_resource 是独立条目组', () => {
    const groups = groupResults([
      entry({ id: 'f1', contentType: 'fact', sourceTable: 'facts' }),
      entry({ id: 'r1', contentType: 'linked_resource', sourceTable: 'linked_resources' }),
    ])
    expect(groups).toHaveLength(2)
    expect(groups.every(g => g.kind === 'standalone')).toBe(true)
  })

  it('contextEntries 邻域条目归入对应组，不参与组间排序分', () => {
    const groups = groupResults(
      [entry({ id: 'm1', contentType: 'message', conversationId: 'convA', createdAt: '2026-09-02T09:00:00Z', score: 0.9, source: 'fts', sourceTable: 'messages' })],
      [entry({ id: 'm0', contentType: 'message', conversationId: 'convA', createdAt: '2026-09-01T09:00:00Z', score: 0, source: 'context-expand', sourceTable: 'messages' })],
    )
    expect(groups).toHaveLength(1)
    if (groups[0].kind === 'conversation') {
      expect(groups[0].items.map(e => e.id)).toEqual(['m0', 'm1'])
    }
  })

  it('邻域 chunk 归入已存在的 doc 组（散块归拢到同一篇）', () => {
    const groups = groupResults(
      [entry({ id: 'c1', contentType: 'feature_chunk', metadata: { chunk_index: 1 }, score: 0.9, source: 'fts' })],
      [entry({ id: 'c0', contentType: 'feature_chunk', metadata: { chunk_index: 0 }, score: 0, source: 'context-expand' })],
    )
    expect(groups).toHaveLength(1)
    if (groups[0].kind === 'doc') {
      expect(groups[0].items.map(e => e.id)).toEqual(['c0', 'c1'])
    }
  })

  it('组间按主结果最高分降序（相关性保留）', () => {
    const groups = groupResults([
      entry({ id: 'docA-chunk', contentType: 'feature_chunk', metadata: { chunk_index: 0 }, score: 0.3, sourceId: 'docA' }),
      entry({ id: 'm1', contentType: 'message', conversationId: 'convA', score: 0.95, sourceId: 's', sourceTable: 'messages' }),
      entry({ id: 'docB-chunk', contentType: 'feature_chunk', metadata: { chunk_index: 0 }, score: 0.7, sourceId: 'docB' }),
    ])
    expect(groups.map(g => g.key)).toEqual(['conv:convA', 'doc:features|docB', 'doc:features|docA'])
  })
})

describe('resolveCreatedAfter', () => {
  const now = Date.parse('2026-09-28T12:00:00Z')

  it('all → undefined（不传 created_after）', () => {
    expect(resolveCreatedAfter('all', now)).toBeUndefined()
    expect(resolveCreatedAfter('', now)).toBeUndefined()
  })

  it('today = 1 天（当前时刻锚点，非自然日边界）', () => {
    expect(resolveCreatedAfter('today', now)).toBe('2026-09-28T12:00:00.000Z')
  })

  it('7d = 当前时刻 - 6 天', () => {
    expect(resolveCreatedAfter('7d', now)).toBe('2026-09-22T12:00:00.000Z')
  })

  it('未知值 → undefined（防御）', () => {
    expect(resolveCreatedAfter('bogus', now)).toBeUndefined()
  })
})
