/**
 * F20260912avlb：活动页——三域台账纯展示（healing / 獭间信号 / 派工）。
 *
 * 需求本质是认知对齐（搭档原话：「我现在只是想更深入了解你们所看到的东西而已，
 * 保证我和你们的认知是一致的」），全只读——无任何写端点，处置走对话内。
 * 页面模式参考 health 页三 tab；中文标签映射在前端（SIGNAL_TYPE_LABELS 同模式）。
 */
import { useState, useEffect, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { ClipboardList, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import '../../styles/globals.css'
import { AppLayout } from '../../components/AppLayout'
import { showToast } from '../../components/Toast'
import * as api from '../../api/client'
import type { HealingEventDTO, SignalEventDTO, DispatchRecordDTO } from '@contract/api'

type Tab = 'healing' | 'signals' | 'dispatch'

const TABS: { key: Tab; label: string }[] = [
  { key: 'healing', label: '自愈事件' },
  { key: 'signals', label: '獭间信号' },
  { key: 'dispatch', label: '派工台账' },
]

/** healing 错误类型中文标签 */
const HEALING_TYPE_LABELS: Record<string, string> = {
  tool_failure: '工具故障',
  missing_context: '上下文缺失',
  wrong_tool: '工具误用',
  format_violation: '格式违规',
  knowledge_gap: '知识缺口',
  performance: '性能问题',
  degenerate: '退化行为',
  circuit_break: '熔断重启',
  self_restart: '自重启',
  guard_intercept: '安全拦截',
  rate_limit: '限流/配额',
  tool_use_feedback: '工具反馈',
  other: '其他',
}

/** 獭间信号类型中文标签 */
const SIGNAL_TYPE_LABELS: Record<string, string> = {
  objection: '异议',
  blocked: '卡住升级',
  halt: '停手',
}

/** 派工状态中文标签 + 色标（客观生命周期三态，无「完成」——完成真相看对话汇报） */
const DISPATCH_STATUS_META: Record<string, { label: string; dot: string; text: string }> = {
  created: { label: '就位待命', dot: 'bg-amber-400', text: 'text-amber-600' },
  dispatched: { label: '已派工', dot: 'bg-sky-500', text: 'text-sky-600' },
  dissolved: { label: '已解散', dot: 'bg-stone-400', text: 'text-stone-500' },
}

const SEVERITY_META: Record<string, { label: string; dot: string; text: string }> = {
  high: { label: '高', dot: 'bg-rose-500', text: 'text-rose-600' },
  medium: { label: '中', dot: 'bg-amber-400', text: 'text-amber-600' },
  low: { label: '低', dot: 'bg-emerald-400', text: 'text-emerald-600' },
  critical: { label: '严重', dot: 'bg-rose-600', text: 'text-rose-700' },
}

const HEALING_STATUS_LABELS: Record<string, string> = {
  open: '待处理',
  analyzing: '分析中',
  resolved: '已解决',
  dismissed: '已忽略',
}

const SIGNAL_STATUS_LABELS: Record<string, string> = {
  pending: '待裁决',
  resolved: '已裁决',
  dismissed: '已驳回',
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  // ISO → 本地可读时间（分钟精度足够——台账浏览场景无秒级需求）
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

function ActivityPage() {
  const initialTab = (['healing', 'signals', 'dispatch'] as const).includes(new URLSearchParams(window.location.search).get('tab') as Tab)
    ? new URLSearchParams(window.location.search).get('tab') as Tab
    : 'healing'
  const [tab, setTab] = useState<Tab>(initialTab)
  const [healingStatus, setHealingStatus] = useState('open')
  const [signalStatus, setSignalStatus] = useState('')
  const [dispatchStatus, setDispatchStatus] = useState('')
  const [healing, setHealing] = useState<HealingEventDTO[]>([])
  const [signals, setSignals] = useState<SignalEventDTO[]>([])
  const [dispatch, setDispatch] = useState<DispatchRecordDTO[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      if (tab === 'healing') {
        const r = await api.getActivityHealing({ status: healingStatus || undefined }, signal)
        if (signal?.aborted) return
        setHealing(r.events)
      } else if (tab === 'signals') {
        const r = await api.getActivitySignals({ status: signalStatus || undefined }, signal)
        if (signal?.aborted) return
        setSignals(r.signals)
      } else {
        const r = await api.getActivityDispatch({ status: dispatchStatus || undefined }, signal)
        if (signal?.aborted) return
        setDispatch(r.records)
      }
    } catch (err) {
      if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) return
      showToast(err instanceof Error ? err.message : '加载失败', 'error')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [tab, healingStatus, signalStatus, dispatchStatus])

  useEffect(() => {
    const ac = new AbortController()
    void refresh(ac.signal)
    return () => ac.abort()
  }, [refresh])

  /** 手动刷新按钮（按需浏览场景——不自动轮询） */
  const manualRefresh = () => { void refresh() }

  const count = tab === 'healing' ? healing.length : tab === 'signals' ? signals.length : dispatch.length

  return (
    <AppLayout activeView="activity">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
          {/* 头部 */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-stone-800 flex items-center gap-2">
                <ClipboardList className="w-5 h-5 text-otter-500" />
                活动台账
              </h1>
              <p className="text-xs text-stone-500 mt-1">海獭运行时三域台账（自愈 / 信号 / 派工）· 纯只读，处置由海獭在对话内进行</p>
            </div>
            <button
              onClick={manualRefresh}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-full bg-otter-500 text-white hover:bg-otter-600 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </button>
          </div>

          {/* Tab 切换 */}
          <div className="flex gap-1 p-1 rounded-full bg-skeleton/70 w-fit">
            {TABS.map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-4 py-1.5 text-sm rounded-full transition-colors ${
                  tab === t.key ? 'bg-white text-otter-600 font-semibold shadow-sm' : 'text-stone-500 hover:text-stone-700'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* ── Tab 1: healing ── */}
          {tab === 'healing' && (
            <div className="space-y-3">
              <FilterChips
                options={[
                  { value: 'open', label: '待处理' },
                  { value: 'resolved', label: '已解决' },
                  { value: 'dismissed', label: '已忽略' },
                  { value: '', label: '全部状态' },
                ]}
                value={healingStatus}
                onChange={setHealingStatus}
              />
              {healing.length === 0 && !loading ? (
                <EmptyState text="没有待处理的自愈事件——系统运行健康。" />
              ) : (
                healing.map(e => <HealingCard key={e.id} event={e} />)
              )}
            </div>
          )}

          {/* ── Tab 2: signals ── */}
          {tab === 'signals' && (
            <div className="space-y-3">
              <div className="text-xs text-stone-400 bg-stone-50 rounded-lg px-3 py-2">
                只读说明：信号裁决是协议义务，保留在对话内由大獭显式处置——此页仅浏览。
              </div>
              <FilterChips
                options={[
                  { value: 'pending', label: '待裁决' },
                  { value: 'resolved', label: '已裁决' },
                  { value: 'dismissed', label: '已驳回' },
                  { value: '', label: '全部状态' },
                ]}
                value={signalStatus}
                onChange={setSignalStatus}
              />
              {signals.length === 0 && !loading ? (
                <EmptyState text="没有信号记录。" />
              ) : (
                [...signals]
                  .sort((a, b) => (a.status === 'pending' ? -1 : 1) - (b.status === 'pending' ? -1 : 1))
                  .map(s => <SignalCard key={s.id} signal={s} />)
              )}
            </div>
          )}

          {/* ── Tab 3: dispatch ── */}
          {tab === 'dispatch' && (
            <div className="space-y-3">
              <div className="text-xs text-stone-400 bg-stone-50 rounded-lg px-3 py-2">
                口径说明：状态是客观生命周期（就位 → 派工 / 解散）。「任务完成与否」的真相在对话汇报里，
                台账不硬造完成态——想知道干得怎么样，去对话页看。
              </div>
              <FilterChips
                options={[
                  { value: '', label: '全部状态' },
                  { value: 'created', label: '就位待命' },
                  { value: 'dispatched', label: '已派工' },
                  { value: 'dissolved', label: '已解散' },
                ]}
                value={dispatchStatus}
                onChange={setDispatchStatus}
              />
              {dispatch.length === 0 && !loading ? (
                <EmptyState text="没有派工记录。" />
              ) : (
                [...dispatch]
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .map(r => <DispatchCard key={r.id} record={r} />)
              )}
            </div>
          )}

          {loading && <div className="text-center text-sm text-stone-400 py-4">加载中…</div>}
          {!loading && count > 0 && (
            <div className="text-center text-xs text-stone-400">共 {count} 条</div>
          )}
        </div>
      </div>
    </AppLayout>
  )
}

/** 过滤 chip 组（单选） */
function FilterChips({ options, value, onChange }: {
  options: { value: string; label: string }[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1 text-xs rounded-full border transition-colors ${
            value === o.value
              ? 'bg-otter-500 text-white border-otter-500'
              : 'text-stone-500 border-stone-200 hover:border-stone-300 bg-white/60'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="text-center py-12 text-stone-400 bg-white/40 rounded-2xl">
      <div className="text-3xl mb-2">🌿</div>
      <div className="text-sm">{text}</div>
    </div>
  )
}

/** healing 事件卡（描述是机器格式长串：截断 + 点击展开全文，不后处理原文） */
function HealingCard({ event }: { event: HealingEventDTO }) {
  const [expanded, setExpanded] = useState(false)
  const sev = SEVERITY_META[event.severity] ?? { label: event.severity, dot: 'bg-stone-400', text: 'text-stone-500' }
  return (
    <div className="bg-white/70 rounded-2xl border border-stone-100 p-4 space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className={`w-2 h-2 rounded-full ${sev.dot}`} title={`严重度：${sev.label}`} />
        <span className="font-medium text-stone-700">{HEALING_TYPE_LABELS[event.errorType] ?? event.errorType}</span>
        <span className="text-stone-400">·</span>
        <span className="text-stone-500">獭 {shortId(event.otterId)}</span>
        <span className="text-stone-400">·</span>
        <span className="text-stone-400">对话 {shortId(event.conversationId)}</span>
        <span className="flex-1" />
        <span className="text-stone-400">{fmtTime(event.createdAt)}</span>
        <span className={`px-2 py-0.5 rounded-full text-[11px] ${
          event.status === 'open' ? 'bg-rose-50 text-rose-600' : event.status === 'resolved' ? 'bg-emerald-50 text-emerald-600' : 'bg-stone-100 text-stone-500'
        }`}>{HEALING_STATUS_LABELS[event.status] ?? event.status}</span>
      </div>
      <button onClick={() => setExpanded(!expanded)} className="text-left w-full text-sm text-stone-600 flex gap-1 items-start">
        <span className={expanded ? '' : 'line-clamp-2 flex-1'}>{event.description}</span>
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 text-stone-400 mt-0.5 flex-shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-stone-400 mt-0.5 flex-shrink-0" />}
      </button>
    </div>
  )
}

/** 獭间信号卡（pending 置顶逻辑在父级排序；已裁决展示裁决文本） */
function SignalCard({ signal }: { signal: SignalEventDTO }) {
  const [expanded, setExpanded] = useState(false)
  const sev = SEVERITY_META[signal.severity] ?? { label: signal.severity, dot: 'bg-stone-400', text: 'text-stone-500' }
  return (
    <div className={`bg-white/70 rounded-2xl border p-4 space-y-2 ${signal.status === 'pending' ? 'border-amber-200' : 'border-stone-100'}`}>
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className={`w-2 h-2 rounded-full ${sev.dot}`} title={`严重度：${sev.label}`} />
        <span className="font-medium text-stone-700">{SIGNAL_TYPE_LABELS[signal.type] ?? signal.type}</span>
        <span className="text-stone-400">·</span>
        <span className="text-stone-500">{shortId(signal.fromOtterId)} → {signal.targetOtterId ? shortId(signal.targetOtterId) : '全场'}</span>
        <span className="text-stone-400">·</span>
        <span className="text-stone-400">对话 {shortId(signal.conversationId)}</span>
        <span className="flex-1" />
        <span className="text-stone-400">{fmtTime(signal.createdAt)}</span>
        <span className={`px-2 py-0.5 rounded-full text-[11px] ${
          signal.status === 'pending' ? 'bg-amber-50 text-amber-600' : 'bg-stone-100 text-stone-500'
        }`}>{SIGNAL_STATUS_LABELS[signal.status] ?? signal.status}</span>
      </div>
      <button onClick={() => setExpanded(!expanded)} className="text-left w-full text-sm text-stone-600 flex gap-1 items-start">
        <span className={expanded ? '' : 'line-clamp-2 flex-1'}>{signal.payload}</span>
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 text-stone-400 mt-0.5 flex-shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-stone-400 mt-0.5 flex-shrink-0" />}
      </button>
      {signal.status !== 'pending' && signal.resolution && (
        <div className="text-xs text-stone-500 bg-stone-50 rounded-lg px-3 py-2">
          裁决：{signal.resolution}{signal.resolvedBy ? `（by ${shortId(signal.resolvedBy)}）` : ''}
        </div>
      )}
    </div>
  )
}

/** 派工记录卡（⬤ = 獭当前在场，实时 join 不落库） */
function DispatchCard({ record }: { record: DispatchRecordDTO }) {
  const meta = DISPATCH_STATUS_META[record.status] ?? { label: record.status, dot: 'bg-stone-400', text: 'text-stone-500' }
  return (
    <div className="bg-white/70 rounded-2xl border border-stone-100 p-4 space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
        <span className={`font-medium ${meta.text}`}>{meta.label}</span>
        <span className="text-stone-400">·</span>
        <span className="text-stone-700 font-semibold">{record.otterName}</span>
        {record.present && <span className="text-emerald-500" title="该獭当前在场">⬤</span>}
        <span className="text-stone-400">·</span>
        <span className="text-stone-400">对话 {shortId(record.conversationId)}</span>
        <span className="flex-1" />
        <span className="text-stone-400">创建 {fmtTime(record.createdAt)}</span>
      </div>
      <div className="text-sm text-stone-600 line-clamp-2">{record.task}</div>
      <div className="flex gap-4 text-[11px] text-stone-400">
        <span>派工：{fmtTime(record.dispatchedAt)}</span>
        <span>解散：{record.dissolvedAt ? fmtTime(record.dissolvedAt) : record.status === 'dissolved' ? '时间未知' : '—'}</span>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<ActivityPage />)
