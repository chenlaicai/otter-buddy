import { Search, Plus, Pin, X, Loader2, ChevronDown, ChevronRight } from 'lucide-react'
import { useRef, useEffect, useState, useCallback } from 'react'
import type { LocalConversation as Conversation, LocalOtter as Otter } from '../../lib/mappers'
import { mapConversationDTO } from '../../lib/mappers'
import { resolveOtterVisual } from '../../lib/otter-visual'
import { fmtRelativeTime } from '../../lib/utils'
import * as api from '../../api/client'

/** F20260918imas：助理分组标题（与后端 DTO kind 标识同步出现） */
const ASSISTANT_GROUP_LABEL = 'IM 助理'
/** F20260922cgrp：三分组标题 */
const CONVERSATION_GROUP_LABEL = '对话'
const ARCHIVED_GROUP_LABEL = '已归档'

/** F20260922cgrp：分组分页固定页大小（搭档拍板：一页固定 20 个，不做下拉加载更多） */
const PAGE_SIZE = 20

type GroupKey = 'assistant' | 'conversation' | 'archived'

/** F20260922cgrp：折叠状态持久化 localStorage（默认：助理开、对话开、归档关） */
const COLLAPSED_KEY = (g: GroupKey) => `leftPanel:collapsed:${g}`

interface LeftPanelProps {
  conversations: Conversation[]
  activeId: string
  onSelect: (id: string) => void
  onNewConversation: () => void
  onContextMenu: (e: React.MouseEvent, cid: string) => void
  otters: Otter[]
  /** F20260922cgrp：数据变化通知（归档/置顶/新建后父组件刷新各分组数据） */
  onRefresh?: () => void
}

/** sessionStorage key for persisting scroll position across MPA page transitions */
const SCROLL_POS_KEY = 'leftPanel:scrollTop'

/**
 * F20260922cgrp：页码跳转器——`‹ 1 2 3 … N ›`，N>10 时折叠中间页（首尾 + 当前±2）。
 * 简单实现：页数 ≤10 全展示；>10 展示 1 … (cur-2..cur+2) … N。
 */
function Pagination({ page, total, onChange, testid }: { page: number; total: number; onChange: (p: number) => void; testid: string }) {
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  if (pageCount <= 1) return null

  const pages: Array<number | 'ellipsis'> = []
  if (pageCount <= 10) {
    for (let i = 1; i <= pageCount; i++) pages.push(i)
  } else {
    const windowStart = Math.max(2, Math.min(page - 2, pageCount - 3))
    const windowEnd = Math.min(pageCount - 1, Math.max(page + 2, 4))
    pages.push(1)
    if (windowStart > 2) pages.push('ellipsis')
    for (let i = windowStart; i <= windowEnd; i++) pages.push(i)
    if (windowEnd < pageCount - 1) pages.push('ellipsis')
    pages.push(pageCount)
  }

  return (
    <div className="flex items-center justify-center gap-0.5 py-1.5" data-testid={testid}>
      <button
        data-testid={`${testid}-prev`}
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        className="w-5 h-5 rounded text-[10px] text-stone-500 hover:bg-white/40 disabled:opacity-30 disabled:cursor-not-allowed transition"
      >
        ‹
      </button>
      {pages.map((p, i) =>
        p === 'ellipsis' ? (
          <span key={`e${i}`} className="text-[10px] text-stone-400 px-0.5">…</span>
        ) : (
          <button
            key={p}
            data-testid={`${testid}-page-${p}`}
            onClick={() => onChange(p)}
            className={`w-5 h-5 rounded text-[10px] transition ${
              p === page
                ? 'bg-otter-400 text-white font-semibold'
                : 'text-stone-500 hover:bg-white/40'
            }`}
          >
            {p}
          </button>
        ),
      )}
      <button
        data-testid={`${testid}-next`}
        disabled={page >= pageCount}
        onClick={() => onChange(page + 1)}
        className="w-5 h-5 rounded text-[10px] text-stone-500 hover:bg-white/40 disabled:opacity-30 disabled:cursor-not-allowed transition"
      >
        ›
      </button>
    </div>
  )
}

/** F20260922cgrp：可折叠分组头（chevron + 标题 + 计数） */
function GroupHeader({
  label,
  count,
  collapsed,
  onToggle,
  testid,
}: {
  label: string
  count: number
  collapsed: boolean
  onToggle: () => void
  testid: string
}) {
  return (
    <button
      data-testid={testid}
      onClick={onToggle}
      className="w-full px-2.5 pt-1.5 pb-0.5 flex items-center gap-1.5 text-left hover:bg-white/20 rounded-lg transition"
    >
      {collapsed ? (
        <ChevronRight className="w-3 h-3 text-stone-400 flex-shrink-0" />
      ) : (
        <ChevronDown className="w-3 h-3 text-stone-400 flex-shrink-0" />
      )}
      <span className="text-[10px] font-semibold text-stone-500 tracking-wide flex-1">{label}</span>
      <span className="text-[10px] text-stone-400" data-testid={`${testid}-count`}>{count}</span>
    </button>
  )
}

export function LeftPanel({ conversations, activeId, onSelect, onNewConversation, onContextMenu, otters, onRefresh }: LeftPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // ── 对话标题搜索（F20260916lpsc）──
  // Why: 就地展开输入框 + 服务端 LIKE 过滤。搜索态下列表替换为命中结果（平铺、不分组不分页），
  // 清空恢复分组视图。防抖 300ms 防每次击键一发请求。
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
        .then(({ items }) => setSearchResults(items.map(mapConversationDTO)))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false))
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [keyword, searchOpen])

  // ── F20260922cgrp：三分组折叠状态（localStorage 持久化；默认 助理开/对话开/归档关）──
  const [collapsed, setCollapsed] = useState<Record<GroupKey, boolean>>(() => ({
    assistant: localStorage.getItem(COLLAPSED_KEY('assistant')) === '1',
    conversation: localStorage.getItem(COLLAPSED_KEY('conversation')) === '1',
    archived: localStorage.getItem(COLLAPSED_KEY('archived')) !== '0', // 默认关
  }))
  const toggleGroup = useCallback((g: GroupKey) => {
    setCollapsed(prev => {
      const next = { ...prev, [g]: !prev[g] }
      localStorage.setItem(COLLAPSED_KEY(g), next[g] ? '1' : '0')
      return next
    })
  }, [])

  // ── F20260922cgrp：分组数据──
  // IM 助理 + 置顶区来自父组件 conversations（全量，数量小）；
  // 普通对话 + 已归档走独立分页查询（每页 20 条 + total 页码跳转）。
  const assistantConvs = conversations.filter(c => c.kind === 'assistant')
  const pinnedConvs = conversations.filter(c => c.kind !== 'assistant' && c.pinned)

  const [normalPage, setNormalPage] = useState(1)
  const [normalItems, setNormalItems] = useState<Conversation[]>([])
  const [normalTotal, setNormalTotal] = useState(0)
  const [archivedPage, setArchivedPage] = useState(1)
  const [archivedItems, setArchivedItems] = useState<Conversation[]>([])
  const [archivedTotal, setArchivedTotal] = useState(0)

  // 普通对话总数（pinned 全量 + normal 分页 total）——normalTotal 经 pinned:false 过滤，
  // 不再含置顶（检视严重 1 修复：原口径 pinnedConvs.length + normalTotal 双重计数置顶项）
  const conversationGroupTotal = pinnedConvs.length + normalTotal

  const loadNormalPage = useCallback((page: number) => {
    api.listConversations({
      status: 'active',
      kind: 'normal',
      pinned: false,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    })
      .then(({ items, total }) => {
        // 检视严重 2 修复：页数收缩 clamp——末页条目归档/删空后重拉回空页时回退到末页，
        // 防止页码器消失造成空白页死锁
        const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
        if (items.length === 0 && page > pageCount) {
          setNormalPage(pageCount)
          return
        }
        setNormalItems(items.map(mapConversationDTO))
        setNormalTotal(total)
      })
      .catch(() => { /* 静默降级——分组拉取失败不阻塞面板 */ })
  }, [])

  const loadArchivedPage = useCallback((page: number) => {
    api.listConversations({
      status: 'archived',
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    })
      .then(({ items, total }) => {
        const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
        if (items.length === 0 && page > pageCount) {
          setArchivedPage(pageCount)
          return
        }
        setArchivedItems(items.map(mapConversationDTO))
        setArchivedTotal(total)
      })
      .catch(() => { /* 静默降级 */ })
  }, [])

  // 初次挂载 + conversations 变化（归档/置顶/新建/轮询刷新）时重拉当前页。
  // 检视建议 7 修复：折叠的组跳过分页【条目】拉取（5s 轮询不再放大 3 倍请求），展开时重拉；
  // 但组头计数必须常显（搭档诉求「分组上要显示当前有几个对话」）——归档组折叠时也需轻量
  // total 查询（limit=1 只取计数，不传 pinned/kind 时后端 COUNT 与列表同 where，成本一致）
  useEffect(() => {
    if (collapsed.conversation) return
    loadNormalPage(normalPage)
  }, [normalPage, conversations, collapsed.conversation, loadNormalPage])
  useEffect(() => {
    if (collapsed.archived) {
      // 折叠时仅拉计数（页码器不可见，条目等展开再拉）
      api.listConversations({ status: 'archived', limit: 1, offset: 0 })
        .then(({ total }) => setArchivedTotal(total))
        .catch(() => { /* 静默降级 */ })
      return
    }
    loadArchivedPage(archivedPage)
  }, [archivedPage, conversations, collapsed.archived, loadArchivedPage])

  // 数据变化通知（供父组件在归档等操作后触发——目前 conversations 依赖已覆盖，保留扩展口）
  useEffect(() => { onRefresh?.() }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
        {searchResults ? (
          /* 搜索态：平铺命中结果（不分组不分页），F20260916lpsc 既有行为保留 */
          <>
            {searchResults.map(c => (
              <ConversationItem
                key={c.id}
                conversation={c}
                isActive={c.id === activeId}
                onSelect={onSelect}
                onContextMenu={onContextMenu}
                otters={otters}
              />
            ))}
            {!searching && searchResults.length === 0 && (
              <div className="p-4 text-xs text-stone-400 text-center" data-testid="leftpanel-search-empty">无匹配对话</div>
            )}
          </>
        ) : (
          <>
            {/* ── 《IM 助理》组：全量显示不分页（数量小）── */}
            <GroupHeader
              label={ASSISTANT_GROUP_LABEL}
              count={assistantConvs.length}
              collapsed={collapsed.assistant}
              onToggle={() => toggleGroup('assistant')}
              testid="leftpanel-group-assistant"
            />
            {!collapsed.assistant && assistantConvs.map(c => (
              <ConversationItem
                key={c.id}
                conversation={c}
                isActive={c.id === activeId}
                onSelect={onSelect}
                onContextMenu={onContextMenu}
                otters={otters}
              />
            ))}

            {/* ── 《对话》组：置顶区（区分底色）+ 普通区（分页 20/页）── */}
            <GroupHeader
              label={CONVERSATION_GROUP_LABEL}
              count={conversationGroupTotal}
              collapsed={collapsed.conversation}
              onToggle={() => toggleGroup('conversation')}
              testid="leftpanel-group-conversation"
            />
            {!collapsed.conversation && (
              <>
                {/* 置顶区：底色区分边界（搭档诉求：置顶/普通边界看不清） */}
                {pinnedConvs.map(c => (
                  <ConversationItem
                    key={c.id}
                    conversation={c}
                    isActive={c.id === activeId}
                    onSelect={onSelect}
                    onContextMenu={onContextMenu}
                    otters={otters}
                    pinnedHighlight
                  />
                ))}
                {pinnedConvs.length > 0 && normalItems.length > 0 && (
                  <div className="my-1 border-t border-white/30" />
                )}
                {normalItems.map(c => (
                  <ConversationItem
                    key={c.id}
                    conversation={c}
                    isActive={c.id === activeId}
                    onSelect={onSelect}
                    onContextMenu={onContextMenu}
                    otters={otters}
                  />
                ))}
                <Pagination
                  page={normalPage}
                  total={normalTotal}
                  onChange={setNormalPage}
                  testid="leftpanel-pagination-conversation"
                />
              </>
            )}

            {/* ── 《已归档》组：独立分页（默认折叠）── */}
            <GroupHeader
              label={ARCHIVED_GROUP_LABEL}
              count={archivedTotal}
              collapsed={collapsed.archived}
              onToggle={() => toggleGroup('archived')}
              testid="leftpanel-group-archived"
            />
            {!collapsed.archived && (
              <>
                {archivedItems.map(c => (
                  <ConversationItem
                    key={c.id}
                    conversation={c}
                    isActive={c.id === activeId}
                    onSelect={onSelect}
                    onContextMenu={onContextMenu}
                    otters={otters}
                  />
                ))}
                {archivedItems.length === 0 && (
                  <div className="px-2.5 py-2 text-[10px] text-stone-400" data-testid="leftpanel-archived-empty">暂无已归档对话</div>
                )}
                <Pagination
                  page={archivedPage}
                  total={archivedTotal}
                  onChange={setArchivedPage}
                  testid="leftpanel-pagination-archived"
                />
              </>
            )}
          </>
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
  pinnedHighlight,
}: {
  conversation: Conversation
  isActive: boolean
  onSelect: (id: string) => void
  onContextMenu: (e: React.MouseEvent, cid: string) => void
  otters: Otter[]
  /** F20260922cgrp：置顶项底色区分（搭档：置顶/普通边界看不清） */
  pinnedHighlight?: boolean
}) {
  const convOtters: Otter[] = c.otterIds
    .map(id => otters.find(o => o.id === id))
    .filter((o): o is Otter => o !== undefined)

  return (
    <div
      onClick={() => onSelect(c.id)}
      onContextMenu={e => onContextMenu(e, c.id)}
      className={`px-2.5 py-2 rounded-xl cursor-pointer transition ${
        isActive
          ? 'conv-active'
          : pinnedHighlight
            ? 'bg-otter-100/50 hover:bg-otter-100/70'
            : 'hover:bg-white/30'
      }`}
      {...(pinnedHighlight ? { 'data-testid': `conv-item-pinned-${c.id}` } : {})}
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
              c.status === 'active' ? 'bg-teal-400' : 'bg-stone-400'
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
            // F20260921otcl：列表项自带身份（LocalOtter.type/color）走库值
            const { color } = resolveOtterVisual(o.id, { type: o.type, color: o.color })
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
