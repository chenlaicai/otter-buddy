/**
 * F20260929mrui：记忆召回结果结构化分组。
 *
 * 搭档原话：「我输入关键字，那召回的是相关的一些东西，而这些东西，
 * 我要能看到数据结构，而不是零散的一堆」——按来源结构归组：
 * - 文档命中（feature/research + feature_chunk/research_chunk）→ 按 doc 聚合，
 *   chunk 按章节路径（chunk_index）排序展示，一篇文章的散块归拢
 * - 对话命中（message）→ 按 conversation 聚合成时间线（createdAt 升序）
 * - 独立条目（fact/linked_resource/术语）→ 独立卡片
 *
 * 邻域扩展条目（expand_context=true 时后端返回的 contextEntries）归入对应组，
 * 渲染层用 source='context-expand' 标识弱化样式；其 score=0 不参与组间排序。
 */
import type { MemoryEntryDTO } from '@contract/api'

export type ResultGroup =
  | {
      kind: 'doc'
      key: string
      sourceId: string
      sourceTable: string
      docTitle: string
      /** doc 级 summary 条目（layer quota 保底返回的 feature/research 条目），可为 null */
      docEntry: MemoryEntryDTO | null
      items: MemoryEntryDTO[]
    }
  | {
      kind: 'conversation'
      key: string
      conversationId: string
      items: MemoryEntryDTO[]
    }
  | {
      kind: 'standalone'
      key: string
      entry: MemoryEntryDTO
    }

const DOC_TYPES = new Set(['feature', 'research'])
const CHUNK_TYPES = new Set(['feature_chunk', 'research_chunk'])

/** chunk metadata.doc_title 提取（doc 组标题 fallback 链：summary → 任一 chunk → sourceId） */
function pickDocTitle(docEntry: MemoryEntryDTO | null, items: MemoryEntryDTO[], sourceId: string): string {
  const fromMeta = (e: MemoryEntryDTO | null | undefined): string | undefined => {
    const t = e?.metadata?.doc_title
    return typeof t === 'string' && t.length > 0 ? t : undefined
  }
    if (fromMeta(docEntry)) return fromMeta(docEntry)!
  for (const item of items) {
    const t = fromMeta(item)
    if (t) return t
  }
  return sourceId
}

/** 组排序分：组内主结果（source!=='context-expand'）的最高 score；邻域条目不计入 */
function groupScore(g: ResultGroup): number {
  if (g.kind === 'standalone') {
    return g.entry.source === 'context-expand' ? 0 : (g.entry.score ?? 0)
  }
  const items = g.kind === 'doc' ? [...(g.docEntry ? [g.docEntry] : []), ...g.items] : g.items
  return items.reduce((m, e) => e.source === 'context-expand' ? m : Math.max(m, e.score ?? 0), 0)
}

/**
 * 分组主函数。组间顺序：按组内主结果最高 score 降序混排——保留相关性排序语义；
 * 组内顺序：doc 组按 chunk_index 升序（章节路径），conversation 组按 createdAt 升序（时间线）。
 */
export function groupResults(entries: MemoryEntryDTO[], contextEntries: MemoryEntryDTO[] = []): ResultGroup[] {
  interface DocAcc { docEntry: MemoryEntryDTO | null; items: MemoryEntryDTO[] }
  const docs = new Map<string, DocAcc>()
  const convs = new Map<string, { items: MemoryEntryDTO[] }>()
  const standalone: MemoryEntryDTO[] = []

  const docKey = (e: MemoryEntryDTO) => `${e.sourceTable}|${e.sourceId}`
  const getDoc = (e: MemoryEntryDTO): DocAcc => {
    let acc = docs.get(docKey(e))
    if (!acc) { acc = { docEntry: null, items: [] }; docs.set(docKey(e), acc) }
    return acc
  }

  /** 主结果入组 */
  const placePrimary = (e: MemoryEntryDTO) => {
    if (CHUNK_TYPES.has(e.contentType) || DOC_TYPES.has(e.contentType)) {
      const acc = getDoc(e)
      if (DOC_TYPES.has(e.contentType) && !acc.docEntry) acc.docEntry = e
      else acc.items.push(e)
    } else if (e.contentType === 'message' && e.conversationId) {
      let acc = convs.get(e.conversationId)
      if (!acc) { acc = { items: [] }; convs.set(e.conversationId, acc) }
      acc.items.push(e)
    } else {
      standalone.push(e)
    }
  }

  /** 邻域条目入组（组不存在时建组；消息组没有主结果也可视作独立邻域时间线） */
  const placeContext = (e: MemoryEntryDTO) => {
    if (CHUNK_TYPES.has(e.contentType) || DOC_TYPES.has(e.contentType)) {
      getDoc(e).items.push(e)
    } else if (e.contentType === 'message' && e.conversationId) {
      let acc = convs.get(e.conversationId)
      if (!acc) { acc = { items: [] }; convs.set(e.conversationId, acc) }
      acc.items.push(e)
    } else {
      standalone.push(e)
    }
  }

  entries.forEach(placePrimary)
  contextEntries.forEach(placeContext)

  const groups: ResultGroup[] = []
  for (const [key, acc] of docs) {
    const representative = acc.docEntry ?? acc.items[0]
    if (!representative) continue
    acc.items.sort((a, b) => Number(a.metadata?.chunk_index ?? 0) - Number(b.metadata?.chunk_index ?? 0))
    groups.push({
      kind: 'doc',
      key: `doc:${key}`,
      sourceId: representative.sourceId,
      sourceTable: representative.sourceTable,
      docTitle: pickDocTitle(acc.docEntry, acc.items, representative.sourceId),
      docEntry: acc.docEntry,
      items: acc.items,
    })
  }
  for (const [conversationId, acc] of convs) {
    acc.items.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    groups.push({ kind: 'conversation', key: `conv:${conversationId}`, conversationId, items: acc.items })
  }
  for (const entry of standalone) {
    groups.push({ kind: 'standalone', key: `item:${entry.id}`, entry })
  }

  groups.sort((a, b) => groupScore(b) - groupScore(a))
  return groups
}

/**
 * 时间过滤快捷项 → created_after ISO 值（now 可注入供测试）。
 * 语义：含今天的 N 个自然日——锚点为「当日本地 00:00 −（N−1）天」。
 * 初版误用 now−（N−1）天（滚动窗口错位）：today 算出当前时刻，而 SQL 过滤是
 * created_at >= ?（sqlite-memory-repository created_at 子句），历史记忆恒空——
 * 检视发现 2（PR #1199 review）修正为自然日起点，见 F20260929mrui 文档「审视处置」。
 */
export function resolveCreatedAfter(preset: string, now = Date.now()): string | undefined {
  if (!preset || preset === 'all') return undefined
  const days: Record<string, number> = { today: 1, '3d': 3, '7d': 7, '30d': 30 }
  const n = days[preset]
  if (n === undefined) return undefined
  const local = new Date(now)
  const startOfToday = new Date(local.getFullYear(), local.getMonth(), local.getDate()).getTime()
  return new Date(startOfToday - (n - 1) * 86400000).toISOString()
}
