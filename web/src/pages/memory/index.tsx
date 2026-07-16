import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Search, Star, MessageSquare, ClipboardList, Lightbulb, Link as LinkIcon, FileText } from 'lucide-react'
import '../../styles/globals.css'

import type { MemoryEntryDTO } from '@contract/api'
import { AppLayout } from '../../components/AppLayout'
import { Modal, ModalButton } from '../../components/Modal'
import { showToast } from '../../components/Toast'
import * as api from '../../api/client'

function MemorySearchPage() {
  const [query, setQuery] = useState('')
  const [layer, setLayer] = useState('')
  const [granularity, setGranularity] = useState('')
  const [results, setResults] = useState<MemoryEntryDTO[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [expandCtx, setExpandCtx] = useState(false)
  const [refineQuery, setRefineQuery] = useState('')
  const [showRefine, setShowRefine] = useState(false)

  async function doSearch(searchQuery?: string) {
    const q = searchQuery ?? query
    if (!q.trim()) return
    setLoading(true)
    setResults(null)
    try {
      const result = await api.searchMemory({
        query: q,
        limit: 20,
        layer: layer || undefined,
        granularity: granularity || undefined,
      })
      setResults(result.entries)
    } catch {
      showToast('搜索失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  async function toggleFlag(id: string) {
    try {
      const entry = results?.find(e => e.id === id)
      if (!entry) return
      await api.flagMemory(id, !entry.userFlagged)
      setResults(prev => prev?.map(e => e.id === id ? { ...e, userFlagged: !e.userFlagged } : e) || null)
      showToast('已标记', 'success')
    } catch {
      showToast('标记失败', 'error')
    }
  }

  const typeIconComponents: Record<string, typeof MessageSquare> = {
    message: MessageSquare,
    conversation_summary: ClipboardList,
    key_fact: Lightbulb,
    linked_resource: LinkIcon,
  }
  const layerLabels: Record<string, string> = {
    working: '工作记忆',
    historical: '历史对话',
    key_info: '关键信息',
  }

  return (
    <AppLayout activeView="memory">
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
            <label className="block text-xs font-medium text-stone-500 mb-1.5">记忆层</label>
            <select value={layer} onChange={e => setLayer(e.target.value)} className="form-input w-full">
              <option value="">全部</option>
              <option value="working">工作记忆</option>
              <option value="historical">历史对话</option>
              <option value="key_info">关键信息</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">粒度</label>
            <select value={granularity} onChange={e => setGranularity(e.target.value)} className="form-input w-full">
              <option value="">全部</option>
              <option value="coarse">粗粒度 (标题/摘要)</option>
              <option value="fine">细粒度 (完整内容)</option>
            </select>
          </div>

          <button
            onClick={() => doSearch()}
            className="w-full py-2 text-sm text-white rounded-xl shadow-glow transition"
            style={{ background: 'linear-gradient(135deg,#A88260,#6B5638)' }}
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
              <div className="text-xs text-stone-400">输入关键词搜索历史对话、关键事实和链接资源</div>
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
              {results.map(e => (
                <div key={e.id} className="glass-card rounded-2xl p-4">
                  <div className="flex items-center gap-2 text-xs text-stone-400 mb-2">
                    <span className="flex items-center gap-1">
                      {(() => { const Icon = typeIconComponents[e.contentType] || FileText; return <Icon className="w-3 h-3" /> })()}
                      {e.contentType}
                    </span>
                    <span>·</span>
                    <span>{e.conversationId || '-'}</span>
                    <span>·</span>
                    <span>{e.createdAt}</span>
                    {e.score !== undefined && (
                      <span className="ml-auto text-otter-500 font-medium">{e.score.toFixed(2)}</span>
                    )}
                    <span className="text-[10px] bg-white/40 px-1.5 py-0.5 rounded-full">{layerLabels[e.layer] || e.layer}</span>
                  </div>
                  <div className="text-sm text-stone-700 mb-2">{e.content}</div>
                  <div className="flex items-center gap-3 text-xs">
                    <button onClick={() => setExpandCtx(true)} className="text-otter-500 hover:underline">展开上下文</button>
                    <button onClick={() => setShowRefine(true)} className="text-otter-500 hover:underline">细化搜索</button>
                    <button onClick={() => showToast('查找相似...', 'info')} className="text-otter-500 hover:underline">查找相似</button>
                    <button
                      onClick={() => toggleFlag(e.id)}
                      className={`ml-auto ${e.userFlagged ? 'text-amber-400' : 'text-stone-300'}`}
                    >
                      <Star className="w-4 h-4" fill={e.userFlagged ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>

      {/* Expand Context Modal */}
      <Modal
        isOpen={expandCtx}
        onClose={() => setExpandCtx(false)}
        title="消息上下文"
        width="600px"
        footer={<ModalButton onClick={() => setExpandCtx(false)}>关闭</ModalButton>}
      >
        <div className="text-sm text-stone-500">上下文详情将在后续版本中展示。</div>
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
