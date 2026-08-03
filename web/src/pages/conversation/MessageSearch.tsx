import { useState, useCallback } from 'react'
import { Search, X } from 'lucide-react'
import * as api from '../../api/client'
import { fmtTime } from '../../lib/utils'
import type { MessageSearchResultDTO } from '@contract/api'

interface MessageSearchProps {
  conversationId: string
  onJumpToMessage: (messageId: string) => void
  onClose: () => void
}

export function MessageSearch({ conversationId, onJumpToMessage, onClose }: MessageSearchProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MessageSearchResultDTO[]>([])
  const [searching, setSearching] = useState(false)

  const handleSearch = useCallback(async () => {
    if (!query.trim()) { setResults([]); return }
    setSearching(true)
    try {
      const res = await api.searchMessages(conversationId, query, 20)
      setResults(res)
    } catch (err) {
      console.error('Search failed:', err)
    } finally {
      setSearching(false)
    }
  }, [query, conversationId])

  return (
    <div className="border-b border-white/40 px-1 py-2 flex-shrink-0">
      <div className="flex items-center gap-1.5">
        <Search className="w-3.5 h-3.5 text-stone-400 flex-shrink-0" />
        <input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSearch() }}
          placeholder="搜索消息..."
          className="flex-1 text-xs bg-transparent outline-none text-stone-700 placeholder:text-stone-400"
        />
        {searching && <span className="text-[10px] text-stone-400">搜索中...</span>}
        <button onClick={handleSearch} className="text-[10px] text-otter-500 hover:text-otter-600 font-medium">搜索</button>
        <button onClick={onClose} className="text-stone-400 hover:text-stone-600"><X className="w-3.5 h-3.5" /></button>
      </div>
      {results.length > 0 && (
        <div className="mt-2 max-h-48 overflow-y-auto space-y-1">
          {results.map(r => (
            <button
              key={r.id}
              onClick={() => { onJumpToMessage(r.id); onClose() }}
              className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-white/40 transition"
            >
              <div className="text-[11px] text-stone-600 line-clamp-2">{r.content}</div>
              <div className="text-[9px] text-stone-400 mt-0.5">{r.sn || '系统'} · {fmtTime(r.ts)}</div>
            </button>
          ))}
        </div>
      )}
      {query && !searching && results.length === 0 && (
        <div className="text-[10px] text-stone-400 mt-2 text-center">无匹配结果</div>
      )}
    </div>
  )
}
