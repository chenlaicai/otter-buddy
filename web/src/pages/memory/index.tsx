import { useState, useRef, useEffect, useMemo } from 'react'
import { Search, Star, MessageSquare, Lightbulb, Link as LinkIcon, FileText, ChevronDown, ChevronRight, FileStack } from 'lucide-react'
import { OTTER_GRADIENT } from '../../lib/otter-colors'

import type { MemoryEntryDTO } from '@contract/api'
import { Modal, ModalButton } from '../../components/Modal'
import { showToast } from '../../components/Toast'
import * as api from '../../api/client'
import { groupResults, resolveCreatedAfter, type ResultGroup } from './group-results'

interface TerminologyMetadata {
  term: string
  aliases?: string[]
  category?: string
  examples?: string[]
}

const SOURCE_LABELS: Record<string, string> = {
  fts: '全文匹配',
  vec: '语义匹配',
  both: '混合匹配',
  anchor: 'ID 锚定',
  'context-expand': '邻域扩展',
}

const typeIconComponents: Record<string, typeof MessageSquare> = {
  message: MessageSquare,
  fact: Lightbulb,
  linked_resource: LinkIcon,
  feature: FileText,
  feature_chunk: FileText,
  research: FileText,
  research_chunk: FileText,
}

const layerLabels: Record<string, string> = {
  working: '工作记忆',
  historical: '历史对话',
  document: '文档层',
}

/** F20260928mrui：contentType 多选清单（与 src/entities/memory/memory-entry.ts 七类对齐） */
const CONTENT_TYPE_OPTIONS = [
  { value: 'message', label: '消息' },
  { value: 'fact', label: '事实' },
  { value: 'linked_resource', label: '资源' },
  { value: 'feature', label: '特性文档' },
  { value: 'feature_chunk', label: '特性分段' },
  { value: 'research', label: '研究文档' },
  { value: 'research_chunk', label: '研究分段' },
] as const

const TIME_PRESETS = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '近 1 天' },
  { value: '3d', label: '近 3 天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
] as const

function HighlightedSnippet({ snippet }: { snippet: string }) {
  const parts = snippet.split(/<\/?b>/)
  return (
    <>
      {parts.map((text, i) =>
        i % 2 === 1
          ? <mark key={i} className="bg-otter-200/60 text-stone-800 rounded px-0.5">{text}</mark>
          : <span key={i}>{text}</span>
      )}
    </>
  )
}

function TerminologyCard({ entry }: { entry: MemoryEntryDTO }) {
  const meta = entry.metadata as TerminologyMetadata | null
  if (!meta?.term) return null

  return (
    <div className="space-y-2">
      <div className="text-base font-semibold text-stone-800">{meta.term}</div>
      <div className="text-sm text-stone-600">{entry.content}</div>
      {meta.aliases && meta.aliases.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {meta.aliases.map(a => (
            <span key={a} className="text-[10px] bg-otter-100 text-otter-700 px-1.5 py-0.5 rounded-full">{a}</span>
          ))}
        </div>
      )}
      {meta.category && (
        <span className="text-[10px] bg-skeleton text-stone-500 px-1.5 py-0.5 rounded-full">{meta.category}</span>
      )}
    </div>
  )
}

/** F20260928mrui：debug 中间分值（召回诊断，高级开关开启时返回） */
function DebugScores({ debug }: { debug: NonNullable<MemoryEntryDTO['debug']> }) {
  const rows = [
    ['rrfScore', debug.rrfScore],
    ['finalScore', debug.finalScore],
    ['timeDecay', debug.timeDecay],
    ['frequencyBoost', debug.frequencyBoost],
    ['multiHitCount', debug.multiHitCount],
  ] as const
  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5" data-testid="debug-scores">
      {rows.map(([k, v]) => v !== undefined && (
        <span key={k} className="text-[10px] font-mono bg-stone-100 text-stone-500 px-1.5 py-0.5 rounded">
          {k}={typeof v === 'number' ? v.toFixed(4) : v}
        </span>
      ))}
    </div>
  )
}

/** 单条记忆的结构化数据面板（id/layer/contentType/granularity/score/来源/metadata） */
function EntryDataPanel({ entry }: { entry: MemoryEntryDTO }) {
  const meta = entry.metadata
  return (
    <div className="mt-2 rounded-lg bg-stone-50/80 border border-stone-200/70 p-2.5 space-y-1.5" data-testid="entry-data-panel">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] font-mono text-stone-500">
        <div>id: <span className="text-stone-700">{entry.id}</span></div>
        <div>contentType: <span className="text-stone-700">{entry.contentType}</span></div>
        <div>layer: <span className="text-stone-700">{layerLabels[entry.layer] || entry.layer}</span></div>
        <div>granularity: <span className="text-stone-700">{entry.granularity}</span></div>
        <div>score: <span className="text-stone-700">{entry.score !== undefined ? entry.score.toFixed(4) : '-'}</span></div>
        <div>source: <span className="text-stone-700">{entry.source ? (SOURCE_LABELS[entry.source] || entry.source) : '-'}</span></div>
        <div className="col-span-2">sourceId: <span className="text-stone-700">{entry.sourceId}</span></div>
        {entry.conversationId && (
          <div className="col-span-2">conversationId: <span className="text-stone-700">{entry.conversationId}</span></div>
        )}
        <div className="col-span-2">createdAt: <span className="text-stone-700">{entry.createdAt}</span></div>
      </div>
      {meta && Object.keys(meta).length > 0 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-stone-400 hover:text-stone-600 select-none">metadata（{Object.keys(meta).length} 字段）</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all bg-white/70 rounded p-2 font-mono text-[10px] leading-relaxed text-stone-500">
            {JSON.stringify(meta, null, 2)}
          </pre>
        </details>
      )}
      {entry.debug && <DebugScores debug={entry.debug} />}
    </div>
  )
}

/** 邻域扩展条目样式弱化标识 */
function ContextBadge() {
  return <span className="text-[10px] bg-sky-50 text-sky-600 border border-sky-100 px-1.5 py-0.5 rounded-full">邻域</span>
}

/**
 * F20260928mrui：单条结果（组内行）。
 * dataStructure 开关（外部组级/全局控制）展开完整数据结构面板。
 */
function ResultItem({ entry, showStructure, onExpand, onSimilar, onFlag }: {
  entry: MemoryEntryDTO
  showStructure: boolean
  onExpand: (id: string) => void
  onSimilar: (id: string) => void
  onFlag?: (id: string) => void
}) {
  const isTerm = entry.metadata !== null && 'term' in (entry.metadata as Record<string, unknown>)
  const isCtx = entry.source === 'context-expand'
  const Icon = typeIconComponents[entry.contentType] || FileText
  return (
    <div className={`px-3 py-2.5 ${isCtx ? 'bg-sky-50/30' : ''}`} data-entry-id={entry.id}>
      <div className="flex items-center gap-2 text-xs text-stone-400 flex-wrap">
        <span className="flex items-center gap-1">
          <Icon className="w-3 h-3" />
          {entry.contentType}
        </span>
        {(() => {
          const hp = !isTerm && entry.metadata && entry.metadata.heading_path
          const path = Array.isArray(hp) ? (hp as unknown[]).filter((x): x is string => typeof x === 'string') : []
          return path.length > 0
            ? <span className="text-stone-500 truncate max-w-[240px]">{path.join(' › ')}</span>
            : null
        })()}
        <span>{new Date(entry.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
        {entry.score !== undefined && entry.score > 0 && (
          <span className="text-otter-500 font-medium">{entry.score.toFixed(2)}</span>
        )}
        {entry.source && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${isCtx ? 'bg-sky-50 text-sky-600' : 'bg-otter-50 text-otter-600'}`}>
            {SOURCE_LABELS[entry.source] || entry.source}
          </span>
        )}
        {isCtx && <ContextBadge />}
        {!isTerm && (
          <span className="text-[10px] bg-white/40 px-1.5 py-0.5 rounded-full">{layerLabels[entry.layer] || entry.layer}</span>
        )}
        <span className="ml-auto flex items-center gap-2.5">
          <button onClick={() => onExpand(entry.id)} className="text-otter-500 hover:underline">{isTerm ? '查看详情' : '展开上下文'}</button>
          <button onClick={() => onSimilar(entry.id)} className="text-otter-500 hover:underline">查找相似</button>
          {onFlag && (
            <button onClick={() => onFlag(entry.id)} className={entry.userFlagged ? 'text-amber-400' : 'text-stone-300'}>
              <Star className="w-3.5 h-3.5" fill={entry.userFlagged ? 'currentColor' : 'none'} />
            </button>
          )}
        </span>
      </div>

      {isTerm ? (
        <div className="mt-1"><TerminologyCard entry={entry} /></div>
      ) : (
        <div className="text-sm text-stone-700 mt-1">
          {entry.snippet ? <HighlightedSnippet snippet={entry.snippet} /> : entry.content}
        </div>
      )}
      {showStructure && <EntryDataPanel entry={entry} />}
    </div>
  )
}

/** 文档组：doc 聚合 + chunk 章节归拢 */
function DocGroupCard({ group, showStructure, onExpand, onSimilar, onFlag }: {
  group: Extract<ResultGroup, { kind: 'doc' }>
  showStructure: boolean
  onExpand: (id: string) => void
  onSimilar: (id: string) => void
  onFlag: (id: string) => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="glass-card rounded-2xl overflow-hidden" data-group-id={group.sourceId}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-white/30 transition"
      >
        {open ? <ChevronDown className="w-4 h-4 text-stone-400" /> : <ChevronRight className="w-4 h-4 text-stone-400" />}
        <FileStack className="w-4 h-4 text-otter-500" />
        <span className="text-sm font-semibold text-stone-800 truncate">{group.docTitle}</span>
        <span className="font-mono text-[11px] text-stone-400">{group.sourceId}</span>
        <span className="ml-auto text-xs text-stone-400">{group.docEntry ? group.items.length + 1 : group.items.length} 条命中</span>
      </button>
      {open && (
        <div className="divide-y divide-stone-100 border-t border-stone-100">
          {group.docEntry && (
            <ResultItem entry={group.docEntry} showStructure={showStructure} onExpand={onExpand} onSimilar={onSimilar} onFlag={onFlag} />
          )}
          {group.items.map(e => (
            <ResultItem key={e.id} entry={e} showStructure={showStructure} onExpand={onExpand} onSimilar={onSimilar} onFlag={onFlag} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 对话组：按 conversation 聚合的时间线 */
function ConversationGroupCard({ group, showStructure, onExpand, onSimilar, onFlag }: {
  group: Extract<ResultGroup, { kind: 'conversation' }>
  showStructure: boolean
  onExpand: (id: string) => void
  onSimilar: (id: string) => void
  onFlag: (id: string) => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="glass-card rounded-2xl overflow-hidden" data-group-id={group.conversationId}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-white/30 transition"
      >
        {open ? <ChevronDown className="w-4 h-4 text-stone-400" /> : <ChevronRight className="w-4 h-4 text-stone-400" />}
        <MessageSquare className="w-4 h-4 text-caramel-600" />
        <span className="text-sm font-semibold text-stone-800 font-mono">{group.conversationId.slice(0, 8)}</span>
        <span className="text-xs text-stone-400">对话时间线</span>
        <span className="ml-auto text-xs text-stone-400">{group.items.length} 条命中</span>
      </button>
      {open && (
        <div className="divide-y divide-stone-100 border-t border-stone-100">
          {group.items.map(e => (
            <ResultItem key={e.id} entry={e} showStructure={showStructure} onExpand={onExpand} onSimilar={onSimilar} onFlag={onFlag} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 独立条目（fact/术语/资源） */
function StandaloneCard({ group, showStructure, onExpand, onSimilar, onFlag }: {
  group: Extract<ResultGroup, { kind: 'standalone' }>
  showStructure: boolean
  onExpand: (id: string) => void
  onSimilar: (id: string) => void
  onFlag: (id: string) => void
}) {
  return (
    <div className="glass-card rounded-2xl p-1">
      <ResultItem entry={group.entry} showStructure={showStructure} onExpand={onExpand} onSimilar={onSimilar} onFlag={onFlag} />
    </div>
  )
}

export default function MemorySearchPage() {
  const [query, setQuery] = useState('')
  const [layer, setLayer] = useState('')
  const [granularity, setGranularity] = useState('')
  const [detailLevel, setDetailLevel] = useState<'summary' | 'snippet' | 'full'>('snippet')
  const [library, setLibrary] = useState('')
  /** F20260928mrui：多条件查询状态 */
  const [contentTypes, setContentTypes] = useState<string[]>([])
  const [timePreset, setTimePreset] = useState('all')
  const [conversationIdFilter, setConversationIdFilter] = useState('')
  const [expandContext, setExpandContext] = useState(false)
  const [debugMode, setDebugMode] = useState(false)
  const [showStructure, setShowStructure] = useState(false)
  const [limit, setLimit] = useState(20)

  const [results, setResults] = useState<MemoryEntryDTO[] | null>(null)
  const [contextResults, setContextResults] = useState<MemoryEntryDTO[]>([])
  const [loading, setLoading] = useState(false)
  const requestIdRef = useRef(0)

  // 展开上下文 Modal
  const [expandEntryId, setExpandEntryId] = useState<string | null>(null)
  const [expandEntry, setExpandEntry] = useState<MemoryEntryDTO | null>(null)
  const [expandLoading, setExpandLoading] = useState(false)
  const [expandError, setExpandError] = useState<string | null>(null)

  // 查找相似 Modal
  const [similarEntryId, setSimilarEntryId] = useState<string | null>(null)
  const [similarResults, setSimilarResults] = useState<MemoryEntryDTO[]>([])
  const [similarLoading, setSimilarLoading] = useState(false)
  const [similarError, setSimilarError] = useState<string | null>(null)
  const similarRequestIdRef = useRef(0)

  // 细化搜索 Modal（保留原功能）
  const [refineQuery, setRefineQuery] = useState('')
  const [showRefine, setShowRefine] = useState(false)

  // F20260803mval: 记忆系统健康状态（降级时显示 banner）
  const [health, setHealth] = useState<api.MemoryHealthDTO | null>(null)
  useEffect(() => {
    api.getMemoryHealth().then(setHealth).catch(() => {})
  }, [])

  // #576（F20260901emps）：初始态加载最近记忆——页面打开即有内容，而非静默引导文案。
  // 切正常搜索后不回退（results !== null 时不再覆盖）；加载失败静默保持原引导文案（降级可接受）
  const [recent, setRecent] = useState<MemoryEntryDTO[] | null>(null)
  useEffect(() => {
    api.getRecentMemory(10)
      .then(r => setRecent(r.entries))
      .catch(() => setRecent([]))
  }, [])

  async function doSearch(searchQuery?: string) {
    const q = searchQuery ?? query
    if (!q.trim()) return
    const myId = ++requestIdRef.current
    setLoading(true)
    setResults(null)
    setContextResults([])
    try {
      const result = await api.searchMemory({
        query: q,
        limit,
        layer: layer || undefined,
        granularity: granularity || undefined,
        detail_level: detailLevel,
        library: library || undefined,
        content_type: contentTypes.length > 0 ? contentTypes : undefined,
        created_after: resolveCreatedAfter(timePreset),
        conversationId: conversationIdFilter.trim() || undefined,
        expand_context: expandContext,
        debug: debugMode,
      })
      if (myId !== requestIdRef.current) return
      setResults(result.entries)
      setContextResults(result.contextEntries ?? [])
    } catch (err) {
      console.error('Failed to search memory:', err)
      showToast('搜索失败', 'error')
    } finally {
      if (myId === requestIdRef.current) setLoading(false)
    }
  }

  /** 结构化分组（F20260928mrui 核心） */
  const resultGroups = useMemo(
    () => results ? groupResults(results, contextResults) : [],
    [results, contextResults],
  )

  async function toggleFlag(id: string) {
    try {
      const all = [...(results ?? []), ...contextResults]
      const entry = all.find(e => e.id === id)
      if (!entry) return
      await api.flagMemory(id, !entry.userFlagged)
      setResults(prev => prev?.map(e => e.id === id ? { ...e, userFlagged: !e.userFlagged } : e) || null)
      setContextResults(prev => prev.map(e => e.id === id ? { ...e, userFlagged: !e.userFlagged } : e))
      showToast('已标记', 'success')
    } catch (err) {
      console.error('Failed to toggle flag:', err)
      showToast('标记失败', 'error')
    }
  }

  async function openEntryDetail(id: string) {
    setExpandEntryId(id)
    setExpandEntry(null)
    setExpandError(null)
    setExpandLoading(true)
    try {
      const entry = await api.getMemoryById(id)
      setExpandEntry(entry)
    } catch (err) {
      console.error('Failed to get memory detail:', err)
      setExpandError('加载失败，请稍后重试')
    } finally {
      setExpandLoading(false)
    }
  }

  async function findSimilar(id: string) {
    const myId = ++similarRequestIdRef.current
    setSimilarEntryId(id)
    setSimilarResults([])
    setSimilarError(null)
    setSimilarLoading(true)
    try {
      const result = await api.searchSimilar(id)
      if (myId !== similarRequestIdRef.current) return
      setSimilarResults(result.entries)
    } catch (err) {
      console.error('Failed to search similar:', err)
      if (myId !== similarRequestIdRef.current) return
      setSimilarError('查找失败，请稍后重试')
    } finally {
      if (myId === similarRequestIdRef.current) setSimilarLoading(false)
    }
  }

  function isTerminology(entry: MemoryEntryDTO): boolean {
    return entry.metadata !== null && 'term' in (entry.metadata as Record<string, unknown>)
  }

  function toggleContentType(v: string) {
    setContentTypes(prev => prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v])
  }

  return (
    <>
      {health && !health.healthy && (
        <div className="mx-3 mt-3 rounded-xl border border-amber-300/60 bg-amber-50/80 px-4 py-2.5 text-sm text-amber-800 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="font-medium">记忆系统降级：</span>
            {health.reconcileGaps?.length > 0 && <span>{health.reconcileGaps.length} 个文档未入库；</span>}
            {!health.embeddingAvailable && <span>语义检索不可用；</span>}
            <span className="text-amber-600">搜索结果可能不完整</span>
          </div>
          {health.gapReasons && health.gapReasons.length > 0 && (
            <ul className="text-xs text-amber-700 space-y-0.5 mt-1 max-h-[var(--section-scroll-max-h)] overflow-y-auto">
              {health.gapReasons.map(r => (
                <li key={r.id} className="font-mono">
                  <span className="font-semibold">{r.id}</span>
                  <span className="text-amber-500"> — </span>
                  {r.errors.join('; ') || '未知原因'}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex flex-1 overflow-hidden p-3 gap-3">
        {/* 检索条件面板（F20260928mrui：多条件查询） */}
        <aside className="w-64 glass rounded-3xl flex flex-col flex-shrink-0 overflow-y-auto p-4 space-y-4">
          <div style={{ fontSize: '16px', fontWeight: 600 }}>记忆召回</div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">召回关键词</label>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doSearch()}
              className="form-input w-full"
              placeholder="输入关键词，如：记忆召回、F2026... ID 会直接锚定文档"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">
              库
              <span className="ml-1 text-stone-400" title="对话库=历史消息/文档分段/事实资源；术语库=项目术语定义">ⓘ</span>
            </label>
            <div className="flex gap-1">
              {[
                { value: '', label: '全部' },
                { value: 'conversation', label: '对话库' },
                { value: 'terminology', label: '术语库' },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setLibrary(opt.value)}
                  className={`flex-1 py-1.5 text-xs rounded-lg transition ${
                    library === opt.value
                      ? 'text-white shadow-sm'
                      : 'text-stone-500 hover:bg-white/40'
                  }`}
                  style={library === opt.value ? { background: OTTER_GRADIENT } : undefined}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">
              内容类型
              <span className="ml-1 text-stone-400" title="多选：不选=全部类型。文档类命中会在结果区按文档归组">ⓘ</span>
            </label>
            <div className="flex flex-wrap gap-1">
              {CONTENT_TYPE_OPTIONS.map(opt => {
                const active = contentTypes.includes(opt.value)
                return (
                  <button
                    key={opt.value}
                    onClick={() => toggleContentType(opt.value)}
                    className={`px-2 py-1 text-[11px] rounded-full border transition ${
                      active
                        ? 'bg-otter-50 text-otter-700 border-otter-300'
                        : 'text-stone-500 border-stone-200 hover:bg-white/40'
                    }`}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">时间范围</label>
            <select value={timePreset} onChange={e => setTimePreset(e.target.value)} className="form-input w-full">
              {TIME_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">记忆层</label>
            <select value={layer} onChange={e => setLayer(e.target.value)} className="form-input w-full">
              <option value="">全部</option>
              <option value="working">工作记忆</option>
              <option value="historical">历史对话</option>
              <option value="document">文档层</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">
              粒度
              <span className="ml-1 text-stone-400" title="控制搜索范围：粗粒度搜索标题和摘要，细粒度搜索完整内容">ⓘ</span>
            </label>
            <select value={granularity} onChange={e => setGranularity(e.target.value)} className="form-input w-full">
              <option value="">全部</option>
              <option value="coarse">粗粒度 (标题/摘要)</option>
              <option value="fine">细粒度 (完整内容)</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">
              详细程度
              <span className="ml-1 text-stone-400" title="控制返回内容量：摘要/片段/全文">ⓘ</span>
            </label>
            <select value={detailLevel} onChange={e => setDetailLevel(e.target.value as 'summary' | 'snippet' | 'full')} className="form-input w-full">
              <option value="summary">摘要</option>
              <option value="snippet">片段 (默认)</option>
              <option value="full">全文</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">
              对话过滤
              <span className="ml-1 text-stone-400" title="只搜该对话内的记忆（conversation ID，可从结果组标题复制）">ⓘ</span>
            </label>
            <input
              value={conversationIdFilter}
              onChange={e => setConversationIdFilter(e.target.value)}
              className="form-input w-full font-mono text-xs"
              placeholder="conversation ID（可选）"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">结果数量</label>
            <select value={limit} onChange={e => setLimit(Number(e.target.value))} className="form-input w-full">
              {[10, 20, 50].map(n => <option key={n} value={n}>{n} 条</option>)}
            </select>
          </div>

          <button
            onClick={() => doSearch()}
            className="w-full py-2 text-sm text-white rounded-xl shadow-glow transition"
            style={{ background: OTTER_GRADIENT }}
          >
            召回
          </button>

          {/* 高级选项 */}
          <div className="border-t border-stone-200/60 pt-3 space-y-2">
            <div className="text-xs font-medium text-stone-400">高级选项</div>
            <label className="flex items-center gap-2 text-xs text-stone-600 cursor-pointer">
              <input type="checkbox" checked={expandContext} onChange={e => setExpandContext(e.target.checked)} className="accent-otter-500" />
              邻域扩展
              <span className="text-stone-400" title="命中分段带前后分段、命中消息带前后消息（结果中以「邻域」标识）">ⓘ</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-stone-600 cursor-pointer">
              <input type="checkbox" checked={showStructure} onChange={e => setShowStructure(e.target.checked)} className="accent-otter-500" />
              显示数据结构
              <span className="text-stone-400" title="每条结果展开完整结构：id/layer/contentType/granularity/score/来源/metadata">ⓘ</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-stone-600 cursor-pointer">
              <input type="checkbox" checked={debugMode} onChange={e => setDebugMode(e.target.checked)} className="accent-otter-500" />
              召回诊断
              <span className="text-stone-400" title="返回中间分值（rrfScore/timeDecay/frequencyBoost 等），用于排查排序问题">ⓘ</span>
            </label>
          </div>
        </aside>

        {/* 结果区：结构化分组呈现（F20260928mrui 核心） */}
        <main className="flex-1 glass rounded-3xl overflow-y-auto p-6">
          {loading && (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <div className="flex gap-1">
                <span className="w-2 h-2 rounded-full bg-otter-400 animate-dot" />
                <span className="w-2 h-2 rounded-full bg-otter-400 animate-dot" style={{ animationDelay: '0.15s' }} />
                <span className="w-2 h-2 rounded-full bg-otter-400 animate-dot" style={{ animationDelay: '0.3s' }} />
              </div>
              <div className="text-sm text-stone-400">召回中...</div>
            </div>
          )}

          {!loading && results === null && recent === null && (
            <div className="flex flex-col items-center justify-center h-full gap-2">
              <Search className="w-10 h-10 text-stone-300" />
              <div className="text-sm font-medium text-stone-400">记忆召回</div>
              <div className="text-xs text-stone-400">输入关键词召回历史对话、文档与关键资源——结果按来源结构归组</div>
            </div>
          )}

          {/* #576：初始态展示最近记忆（有内容可看可点，展开详情走既有 Modal） */}
          {!loading && results === null && recent !== null && recent.length > 0 && (
            <div className="max-w-[860px] mx-auto space-y-3">
              <div className="flex items-center justify-between mb-1">
                <div className="text-sm font-medium text-stone-500">最近记忆</div>
                <div className="text-xs text-stone-400">输入关键词召回历史对话、文档与关键资源</div>
              </div>
              {recent.map(e => {
                const isTerm = isTerminology(e)
                return (
                  <div key={e.id} className="glass-card rounded-2xl p-4">
                    <div className="flex items-center gap-2 text-xs text-stone-400 mb-2">
                      {!isTerm && (
                        <>
                          <span className="flex items-center gap-1">
                            {(() => { const Icon = typeIconComponents[e.contentType] || FileText; return <Icon className="w-3 h-3" /> })()}
                            {e.contentType}
                          </span>
                          <span>·</span>
                          <span className="font-mono">{e.conversationId ? e.conversationId.slice(0, 8) : '-'}</span>
                          <span>·</span>
                        </>
                      )}
                      <span>{new Date(e.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                      {!isTerm && (
                        <span className="text-[10px] bg-white/40 px-1.5 py-0.5 rounded-full">
                          {layerLabels[e.layer] || e.layer}
                        </span>
                      )}
                    </div>

                    {isTerm ? (
                      <TerminologyCard entry={e} />
                    ) : (
                      <div className="text-sm text-stone-700 line-clamp-3">{e.content}</div>
                    )}

                    <div className="flex items-center gap-3 text-xs mt-2">
                      <button onClick={() => openEntryDetail(e.id)} className="text-otter-500 hover:underline">
                        {isTerm ? '查看详情' : '展开上下文'}
                      </button>
                      <button onClick={() => findSimilar(e.id)} className="text-otter-500 hover:underline">查找相似</button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* #576：recent 为空数组 = 环境无数据（区分于加载中）——显式空态文案 */}
          {!loading && results === null && recent !== null && recent.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-2">
              <Search className="w-10 h-10 text-stone-300" />
              <div className="text-sm font-medium text-stone-400">暂无记忆数据</div>
              <div className="text-xs text-stone-400">系统尚无历史对话或文档入库——正常使用后这里会展示最近记忆</div>
            </div>
          )}

          {!loading && results !== null && results.length === 0 && contextResults.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-2">
              <Search className="w-10 h-10 text-stone-300" />
              <div className="text-sm font-medium text-stone-400">未找到相关记忆</div>
              <div className="text-xs text-stone-400">尝试调整召回词或过滤条件</div>
            </div>
          )}

          {!loading && resultGroups.length > 0 && (
            <div className="max-w-[860px] mx-auto space-y-3">
              {/* 汇总行：组结构概览 */}
              <div className="flex items-center gap-3 text-xs text-stone-400 flex-wrap">
                <span>
                  召回 {results!.length} 条
                  {contextResults.length > 0 && <span className="text-sky-500">（含邻域 {contextResults.length} 条）</span>}
                </span>
                <span>·</span>
                <span data-testid="group-summary">
                  {[['doc', '文档'], ['conversation', '对话'], ['standalone', '独立条目']].map(([k, label]) => {
                    const n = resultGroups.filter(g => g.kind === k).length
                    return n > 0 ? <span key={k} className="mr-2">{label} {n}</span> : null
                  })}
                </span>
                <button onClick={() => setShowRefine(true)} className="ml-auto text-otter-500 hover:underline">细化搜索</button>
              </div>
              {resultGroups.map(g => {
                if (g.kind === 'doc') {
                  return <DocGroupCard key={g.key} group={g} showStructure={showStructure} onExpand={openEntryDetail} onSimilar={findSimilar} onFlag={toggleFlag} />
                }
                if (g.kind === 'conversation') {
                  return <ConversationGroupCard key={g.key} group={g} showStructure={showStructure} onExpand={openEntryDetail} onSimilar={findSimilar} onFlag={toggleFlag} />
                }
                return <StandaloneCard key={g.key} group={g} showStructure={showStructure} onExpand={openEntryDetail} onSimilar={findSimilar} onFlag={toggleFlag} />
              })}
            </div>
          )}
        </main>
      </div>

      {/* Expand Context Modal */}
      <Modal
        isOpen={expandEntryId !== null}
        onClose={() => { setExpandEntryId(null); setExpandEntry(null) }}
        title="记忆详情"
        width="600px"
        footer={<ModalButton onClick={() => { setExpandEntryId(null); setExpandEntry(null) }}>关闭</ModalButton>}
      >
        {expandLoading && (
          <div className="flex items-center justify-center py-8">
            <div className="text-sm text-stone-400">加载中...</div>
          </div>
        )}
        {!expandLoading && expandEntry && (
          <div className="space-y-3">
            <div className="text-sm text-stone-700 whitespace-pre-wrap">{expandEntry.content}</div>
            <EntryDataPanel entry={expandEntry} />
          </div>
        )}
        {!expandLoading && !expandEntry && expandEntryId && (
          <div className="text-sm text-stone-500 text-center py-8">
            {expandError || '该记忆条目不存在或已被删除'}
          </div>
        )}
      </Modal>

      {/* Find Similar Modal */}
      <Modal
        isOpen={similarEntryId !== null}
        onClose={() => { setSimilarEntryId(null); setSimilarResults([]) }}
        title="相似记忆"
        width="600px"
        footer={<ModalButton onClick={() => { setSimilarEntryId(null); setSimilarResults([]) }}>关闭</ModalButton>}
      >
        {similarLoading && (
          <div className="flex items-center justify-center py-8">
            <div className="text-sm text-stone-400">查找中...</div>
          </div>
        )}
        {!similarLoading && similarResults.length === 0 && (
          <div className="text-sm text-stone-500 text-center py-8">
            {similarError || '未找到相似记忆'}
          </div>
        )}
        {!similarLoading && similarResults.length > 0 && (
          <div className="space-y-3">
            {similarResults.map(e => (
              <div key={e.id} className="p-3 rounded-xl bg-white/40">
                <div className="text-xs text-stone-400 mb-1">
                  {e.contentType} · {new Date(e.createdAt).toLocaleString('zh-CN', { hour12: false })}
                  {e.score !== undefined && <span className="ml-2 text-otter-500">{e.score.toFixed(2)}</span>}
                </div>
                <div className="text-sm text-stone-700">{e.content}</div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* Refine Search Modal */}
      <Modal
        isOpen={showRefine}
        onClose={() => setShowRefine(false)}
        title="细化搜索"
        footer={
          <>
            <ModalButton onClick={() => setShowRefine(false)}>取消</ModalButton>
            <ModalButton variant="primary" onClick={() => { setShowRefine(false); doSearch(refineQuery) }}>搜索</ModalButton>
          </>
        }
      >
        <label className="block text-xs font-medium text-stone-500 mb-1.5">调整查询</label>
        <input
          value={refineQuery}
          onChange={e => setRefineQuery(e.target.value)}
          className="form-input w-full"
          placeholder="输入调整后的查询..."
        />
        <p className="text-xs text-stone-400 mt-2">基于上次召回结果调整查询词（过滤条件在左侧面板）</p>
      </Modal>
    </>
  )
}
