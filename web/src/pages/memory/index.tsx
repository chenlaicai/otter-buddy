import { useState, useRef, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Search, Star, MessageSquare, Lightbulb, Link as LinkIcon, FileText } from 'lucide-react'
import { OTTER_GRADIENT } from '../../lib/otter-colors'
import '../../styles/globals.css'

import type { MemoryEntryDTO } from '@contract/api'
import { AppLayout } from '../../components/AppLayout'
import { Modal, ModalButton } from '../../components/Modal'
import { showToast } from '../../components/Toast'
import * as api from '../../api/client'

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
}

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
        <span className="text-[10px] bg-stone-100 text-stone-500 px-1.5 py-0.5 rounded-full">{meta.category}</span>
      )}
    </div>
  )
}

function MemorySearchPage() {
  const [query, setQuery] = useState('')
  const [layer, setLayer] = useState('')
  const [granularity, setGranularity] = useState('')
  const [detailLevel, setDetailLevel] = useState<'summary' | 'snippet' | 'full'>('snippet')
  const [library, setLibrary] = useState('')
  const [results, setResults] = useState<MemoryEntryDTO[] | null>(null)
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

  async function doSearch(searchQuery?: string) {
    const q = searchQuery ?? query
    if (!q.trim()) return
    const myId = ++requestIdRef.current
    setLoading(true)
    setResults(null)
    try {
      const result = await api.searchMemory({
        query: q,
        limit: 20,
        layer: layer || undefined,
        granularity: granularity || undefined,
        detail_level: detailLevel,
        library: library || undefined,
      })
      if (myId !== requestIdRef.current) return
      setResults(result.entries)
    } catch (err) {
      console.error('Failed to search memory:', err)
      showToast('搜索失败', 'error')
    } finally {
      if (myId === requestIdRef.current) setLoading(false)
    }
  }

  async function toggleFlag(id: string) {
    try {
      const entry = results?.find(e => e.id === id)
      if (!entry) return
      await api.flagMemory(id, !entry.userFlagged)
      setResults(prev => prev?.map(e => e.id === id ? { ...e, userFlagged: !e.userFlagged } : e) || null)
      showToast('已标记', 'success')
    } catch (err) {
      console.error('Failed to toggle flag:', err)
      showToast('标记失败', 'error')
    }
  }

  async function expandContext(id: string) {
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

  return (
    <AppLayout activeView="memory">
      {health && !health.healthy && (
        <div className="mx-3 mt-3 rounded-xl border border-amber-300/60 bg-amber-50/80 px-4 py-2.5 text-sm text-amber-800 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="font-medium">记忆系统降级：</span>
            {health.reconcileGaps?.length > 0 && <span>{health.reconcileGaps.length} 个文档未入库；</span>}
            {!health.embeddingAvailable && <span>语义检索不可用；</span>}
            <span className="text-amber-600">搜索结果可能不完整</span>
          </div>
          {health.gapReasons && health.gapReasons.length > 0 && (
            <ul className="text-xs text-amber-700 space-y-0.5 mt-1 max-h-40 overflow-y-auto">
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
        {/* Search Panel */}
        <aside className="w-64 glass rounded-3xl flex flex-col flex-shrink-0 overflow-y-auto p-4 space-y-4">
          <div style={{ fontSize: '16px', fontWeight: 600 }}>记忆搜索</div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">搜索关键词</label>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doSearch()}
              className="form-input w-full"
              placeholder="输入搜索内容..."
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">
              库选择
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
            <label className="block text-xs font-medium text-stone-500 mb-1.5">记忆层</label>
            <select value={layer} onChange={e => setLayer(e.target.value)} className="form-input w-full">
              <option value="">全部</option>
              <option value="working">工作记忆</option>
              <option value="historical">历史对话</option>
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

          <button
            onClick={() => doSearch()}
            className="w-full py-2 text-sm text-white rounded-xl shadow-glow transition"
            style={{ background: OTTER_GRADIENT }}
          >
            搜索
          </button>
        </aside>

        {/* Results */}
        <main className="flex-1 glass rounded-3xl overflow-y-auto p-6">
          {loading && (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <div className="flex gap-1">
                <span className="w-2 h-2 rounded-full bg-otter-400 animate-dot" />
                <span className="w-2 h-2 rounded-full bg-otter-400 animate-dot" style={{ animationDelay: '0.15s' }} />
                <span className="w-2 h-2 rounded-full bg-otter-400 animate-dot" style={{ animationDelay: '0.3s' }} />
              </div>
              <div className="text-sm text-stone-400">搜索中...</div>
            </div>
          )}

          {!loading && results === null && (
            <div className="flex flex-col items-center justify-center h-full gap-2">
              <Search className="w-10 h-10 text-stone-300" />
              <div className="text-sm font-medium text-stone-400">搜索记忆</div>
              <div className="text-xs text-stone-400">输入关键词搜索历史对话和关键资源</div>
            </div>
          )}

          {!loading && results !== null && results.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-2">
              <Search className="w-10 h-10 text-stone-300" />
              <div className="text-sm font-medium text-stone-400">未找到相关记忆</div>
              <div className="text-xs text-stone-400">尝试调整搜索词或过滤器</div>
            </div>
          )}

          {!loading && results !== null && results.length > 0 && (
            <div className="max-w-[800px] mx-auto space-y-3">
              {results.map(e => {
                const isTerm = isTerminology(e) && library === 'terminology'
                return (
                  <div key={e.id} className="glass-card rounded-2xl p-4">
                    <div className="flex items-center gap-2 text-xs text-stone-400 mb-2">
                      {!isTerm && (
                        <>
                          <span className="flex items-center gap-1">
                            {(() => { const Icon = typeIconComponents[e.contentType] || FileText; return <Icon className="w-3 h-3" /> })()}
                            {e.contentType}
                          </span>
                          {e.metadata?.heading_path && Array.isArray(e.metadata.heading_path) && (e.metadata.heading_path as string[]).length > 0 && (
                            <>
                              <span>·</span>
                              <span className="text-stone-500 truncate max-w-[200px]">{(e.metadata.heading_path as string[]).join(' › ')}</span>
                            </>
                          )}
                          <span>·</span>
                          <span>{e.conversationId || '-'}</span>
                          <span>·</span>
                        </>
                      )}
                      <span>{e.createdAt}</span>
                      {e.score !== undefined && (
                        <span className="ml-auto text-otter-500 font-medium">{e.score.toFixed(2)}</span>
                      )}
                      {e.source && (
                        <span className="text-[10px] bg-otter-50 text-otter-600 px-1.5 py-0.5 rounded-full">
                          {SOURCE_LABELS[e.source] || e.source}
                        </span>
                      )}
                      {!isTerm && (
                        <span className="text-[10px] bg-white/40 px-1.5 py-0.5 rounded-full">
                          {layerLabels[e.layer] || e.layer}
                        </span>
                      )}
                    </div>

                    {isTerm ? (
                      <TerminologyCard entry={e} />
                    ) : (
                      <div className="text-sm text-stone-700 mb-2">
                        {e.snippet ? <HighlightedSnippet snippet={e.snippet} /> : e.content}
                      </div>
                    )}

                    <div className="flex items-center gap-3 text-xs">
                      <button onClick={() => expandContext(e.id)} className="text-otter-500 hover:underline">
                        {isTerm ? '查看详情' : '展开上下文'}
                      </button>
                      <button onClick={() => setShowRefine(true)} className="text-otter-500 hover:underline">细化搜索</button>
                      <button onClick={() => findSimilar(e.id)} className="text-otter-500 hover:underline">查找相似</button>
                      <button
                        onClick={() => toggleFlag(e.id)}
                        className={`ml-auto ${e.userFlagged ? 'text-amber-400' : 'text-stone-300'}`}
                      >
                        <Star className="w-4 h-4" fill={e.userFlagged ? 'currentColor' : 'none'} />
                      </button>
                    </div>
                  </div>
                )
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
            <div className="border-t border-stone-200 pt-3 space-y-1 text-xs text-stone-400">
              {expandEntry.conversationId && <div>对话: {expandEntry.conversationId}</div>}
              <div>类型: {expandEntry.contentType}</div>
              <div>层: {layerLabels[expandEntry.layer] || expandEntry.layer}</div>
              <div>创建时间: {expandEntry.createdAt}</div>
            </div>
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
                  {e.contentType} · {e.createdAt}
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
        <p className="text-xs text-stone-400 mt-2">基于上次搜索结果调整查询参数</p>
      </Modal>
    </AppLayout>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<MemorySearchPage />)
