import { Search, Plus, Pin, X, Loader2 } from 'lucide-react'
import { useRef, useEffect, useState, useCallback } from 'react'
import type { LocalConversation as Conversation, LocalOtter as Otter } from '../../lib/mappers'
import { mapConversationDTO } from '../../lib/mappers'
import { getOtterColor } from '../../lib/otter-colors'
import { fmtRelativeTime } from '../../lib/utils'
import * as api from '../../api/client'

/** F20260918imas：助理分组标题（与后端 DTO kind 标识同步出现） */
const ASSISTANT_GROUP_LABEL = 'IM 助理'

interface LeftPanelProps {
  conversations: Conversation[]
  activeId: string
  onSelect: (id: string) => void
  onNewConversation: () => void
  onContextMenu: (e: React.MouseEvent, cid: string) => void
  otters: Otter[]
  /** 加载更多（分页追加），父组件负责拉取并合并；缺省不显示按钮 */
  onLoadMore?: () => void
  /** 是否还有下一页可加载 */
  hasMore?: boolean
  /** 加载更多进行中的 spinner 态 */
  loadingMore?: boolean
}

/** sessionStorage key for persisting scroll position across MPA page transitions */
const SCROLL_POS_KEY = 'leftPanel:scrollTop'

export function LeftPanel({ conversations, activeId, onSelect, onNewConversation, onContextMenu, otters, onLoadMore, hasMore, loadingMore }: LeftPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // ── 对话标题搜索（F20260916lpsc）──
  // Why: 就地展开输入框 + 服务端 LIKE 过滤——替代原跳 /memory 的行为（搭档 9/16：
  // 「我更想要搜索对话的标题关键字匹配」）。搜索态下列表替换为命中结果（含 50 条以外的
  // 对话），清空恢复父组件列表。防抖 300ms 防每次击键一发请求。
  const [searchOpen, setSearchOpen] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [searchResults, setSearchResults] = useState<Conversation[] | null>(null)
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setKeyword('')
    setSearchResults(null)
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }, [])

  useEffect(() => {
    if (!searchOpen) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const kw = keyword.trim()
    if (!kw) { setSearchResults(null); setSearching(false); return }
    setSearching(true)
    debounceRef.current = setTimeout(() => {
      api.listConversations({ search: kw, limit: 50 })
        .then(dtos => setSearchResults(dtos.map(mapConversationDTO)))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false))
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [keyword, searchOpen])

  const displayConvs = searchResults ?? conversations
  // F20260918imas：助理对话固定独立分组（不与普通对话混排）；组内仍保留置顶优先
  const displayAssistant = displayConvs.filter(c => c.kind === 'assistant')
  const displayNonAssistant = displayConvs.filter(c => c.kind !== 'assistant')
  const displayPinned = displayNonAssistant.filter(c => c.pinned)
  const displayNormal = displayNonAssistant.filter(c => !c.pinned)

  // 恢复上次保存的滚动位置（整页刷新后）
  useEffect(() => {
    const saved = sessionStorage.getItem(SCROLL_POS_KEY)
    if (!saved || !scrollRef.current) return
    const top = parseInt(saved, 10)
    sessionStorage.removeItem(SCROLL_POS_KEY)
    if (!isNaN(top)) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top })
      })
    }
  }, [])

  // 页面卸载前保存滚动位置（覆盖所有 MPA 导航路径：href、reload、anchor 等）
  useEffect(() => {
    function saveScrollPosition() {
      if (scrollRef.current) {
        sessionStorage.setItem(SCROLL_POS_KEY, String(scrollRef.current.scrollTop))
      }
    }
    window.addEventListener('beforeunload', saveScrollPosition)
    return () => window.removeEventListener('beforeunload', saveScrollPosition)
  }, [])

  return (
    <aside className="w-56 h-full glass rounded-3xl flex flex-col flex-shrink-0 overflow-hidden">
      <div className="p-3 flex gap-2 border-b border-white/40">
        <button
          data-testid="leftpanel-search-toggle"
          onClick={() => setSearchOpen(true)}
          className="w-8 h-8 rounded-xl flex items-center justify-center text-stone-500 hover:bg-white/40 transition"
          title="搜索对话标题"
        >
          <Search className="w-4 h-4" />
        </button>
        <button
          onClick={onNewConversation}
          className="flex-1 py-1.5 text-xs font-medium text-otter-500 border border-otter-300/30 rounded-xl hover:bg-white/40 transition flex items-center justify-center gap-1"
        >
          <Plus className="w-3.5 h-3.5" /> 新建对话
        </button>
      </div>
      {searchOpen && (
        <div className="px-3 py-2 flex items-center gap-1.5 border-b border-white/40" data-testid="leftpanel-search-bar">
          <Search className="w-3.5 h-3.5 text-stone-400 flex-shrink-0" />
          <input
            ref={searchInputRef}
            autoFocus
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') closeSearch() }}
            placeholder="搜索对话标题…"
            className="flex-1 min-w-0 text-xs bg-white/40 rounded-lg px-2 py-1.5 outline-none placeholder:text-stone-400"
          />
          {searching && <Loader2 className="w-3.5 h-3.5 animate-spin text-stone-400 flex-shrink-0" />}
          <button
            data-testid="leftpanel-search-close"
            onClick={closeSearch}
            className="w-6 h-6 rounded-lg flex items-center justify-center text-stone-400 hover:bg-white/40 transition flex-shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2">
        {displayAssistant.length > 0 && (
          <>
            {/* F20260920imax：IM 助理分组——teal 色点 + 徽章计数，与工作对话视觉区隔 */}
            <div className="px-2.5 pt-1 pb-0.5 flex items-center gap-1.5" data-testid="leftpanel-assistant-group-label">
              <span className="w-1.5 h-1.5 rounded-full bg-teal-500" />
              <span className="text-[10px] font-semibold text-teal-700 tracking-wide">{ASSISTANT_GROUP_LABEL}</span>
              <span className="text-[10px] text-stone-400">{displayAssistant.length}</span>
            </div>
            {displayAssistant.map(c => (
              <ConversationItem
                key={c.id}
                conversation={c}
                isActive={c.id === activeId}
                onSelect={onSelect}
                onContextMenu={onContextMenu}
                otters={otters}
              />
            ))}
            <div className="my-1 border-t border-white/30" />
          </>
        )}
        {displayPinned.length > 0 && (
          <div className="px-2.5 pt-1 pb-0.5 text-[10px] font-medium text-stone-400 uppercase tracking-wide">置顶</div>
        )}
        {displayPinned.map(c => (
          <ConversationItem
            key={c.id}
            conversation={c}
            isActive={c.id === activeId}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            otters={otters}
          />
        ))}
        {displayPinned.length > 0 && displayNormal.length > 0 && (
          <div className="my-1 border-t border-white/30" />
        )}
        {displayNormal.map(c => (
          <ConversationItem
            key={c.id}
            conversation={c}
            isActive={c.id === activeId}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            otters={otters}
          />
        ))}
        {searchResults && !searching && displayConvs.length === 0 && (
          <div className="p-4 text-xs text-stone-400 text-center" data-testid="leftpanel-search-empty">无匹配对话</div>
        )}
        {!searchResults && hasMore && onLoadMore && (
          <button
            data-testid="leftpanel-load-more"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="w-full mt-1 py-1.5 text-xs text-stone-500 hover:bg-white/30 rounded-xl transition flex items-center justify-center gap-1"
          >
            {loadingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            加载更多
          </button>
        )}
      </div>
    </aside>
  )
}

function ConversationItem({
  conversation: c,
  isActive,
  onSelect,
  onContextMenu,
  otters,
}: {
  conversation: Conversation
  isActive: boolean
  onSelect: (id: string) => void
  onContextMenu: (e: React.MouseEvent, cid: string) => void
  otters: Otter[]
}) {
  const convOtters: Otter[] = c.otterIds
    .map(id => otters.find(o => o.id === id))
    .filter((o): o is Otter => o !== undefined)

  return (
    <div
      onClick={() => onSelect(c.id)}
      onContextMenu={e => onContextMenu(e, c.id)}
      className={`px-2.5 py-2 rounded-xl cursor-pointer transition ${
        isActive ? 'conv-active' : 'hover:bg-white/30'
      }`}
    >
      <div className="flex items-center gap-1.5">
        <div className="text-xs font-medium text-stone-700 truncate flex-1 flex items-center gap-1">
          {c.pinned && <Pin className="w-3 h-3 text-otter-400 flex-shrink-0" />}
          <span className="truncate">{c.title}</span>
        </div>
        {c.lastMessageTs && (
          <span className="text-[10px] text-stone-400 flex-shrink-0">
            {fmtRelativeTime(c.lastMessageTs)}
          </span>
        )}
        {c.unreadCount != null && c.unreadCount > 0 && (
          <span className="min-w-[16px] h-4 px-1 rounded-full bg-red-400 text-white text-[9px] font-bold flex items-center justify-center flex-shrink-0">
            {c.unreadCount > 99 ? '99+' : c.unreadCount}
          </span>
        )}
      </div>
      {c.lastMessagePreview && (
        <div className="text-[10px] text-stone-400 truncate mt-0.5">{c.lastMessagePreview}</div>
      )}
      <div className="flex items-center gap-1 mt-0.5">
        <div className="flex items-center gap-0.5">
          <div
            className={`w-1 h-1 rounded-full ${
              c.status === 'active' ? 'bg-teal-400' : c.status === 'completed' ? 'bg-otter-400' : 'bg-stone-400'
            }`}
          />
          {c.activityStatus === 'processing' && (
            <span className="flex items-center gap-0.5">
              <div className="w-1 h-1 rounded-full bg-teal-400 animate-pulse" />
              <span className="text-[9px] text-teal-500">处理中</span>
            </span>
          )}
          {c.activityStatus === 'awaiting_user' && (
            <span className="flex items-center gap-0.5">
              <div className="w-1 h-1 rounded-full bg-amber-400" />
              <span className="text-[9px] text-amber-500">等待中</span>
            </span>
          )}
        </div>
        <div className="flex ml-auto">
          {convOtters.map(o => {
            const color = getOtterColor(o.id)
            return (
              <div
                key={o.id}
                className="w-4 h-4 rounded-full border-2 border-white flex items-center justify-center text-[7px] font-bold text-white"
                style={{ background: color.hex }}
              >
                {o.name.charAt(0)}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
