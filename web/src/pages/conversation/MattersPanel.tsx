import { useState } from 'react'
import { ClipboardList, Plus, ChevronDown, ChevronRight } from 'lucide-react'
import type { MatterDTO } from '../../api/client'
import { OTTER_GRADIENT } from '../../lib/otter-colors'
import { useMatters, type MatterAction } from './hooks/useMatters'

/**
 * F20261006mtlp P1 只读板 + F20261006mlp2 P2 交互层。
 *
 * P2 范围（方案 §5 就地操作 + §3.5 通道 B）：
 * - WAITING_PARTNER 条目内嵌裁决按钮（批准/否决/打回）
 * - DONE_PENDING_CONFIRM 条目「确认闭环/打回」
 * - 折叠「近期闭环」区 = 翻案入口（CLOSED → OPEN）
 * - 「+」登记入口（准入路径 2：搭档手动登记，initialState=OPEN）
 *
 * 按钮架构（F20261006mlp2「按钮挂点架构定案」= 回执代执行通道 B）：
 * 按钮不新增 HTTP 写端点，合成 html-matter-action 回执、经 onRouteToOtter(owner)
 * 复用 sendMessage SSE 管线路由 owner 獭，由其 transition_matter(on_behalf_of='partner')
 * 代执行迁移（守卫语义不变）。owner 已解散时后端自动退派在场大獭兜底，按钮仍可用。
 *
 * 样式严格沿用现有 tab 体系（glass 面板/glass-card 条目/otter 渐变主按钮，采样自
 * MessageInput 发送键与 P1 面板），不自造任何风格。
 */

/** 状态徽章文案与配色（沿用面板 stone/teal/amber 色系） */
const STATE_BADGE: Record<string, { label: string; className: string }> = {
  WAITING_PARTNER: { label: '待你裁决', className: 'bg-amber-400/15 text-amber-600' },
  DONE_PENDING_CONFIRM: { label: '待确认闭环', className: 'bg-teal-400/15 text-teal-600' },
  WAITING_OTTER: { label: '獭处理中', className: 'bg-stone-400/15 text-stone-500' },
  OPEN: { label: '待认领', className: 'bg-stone-400/15 text-stone-400' },
  CLOSED: { label: '已闭环', className: 'bg-stone-400/15 text-stone-400' },
  SUPERSEDED: { label: '已被取代', className: 'bg-stone-400/15 text-stone-400' },
  ABANDONED: { label: '已不做', className: 'bg-stone-400/15 text-stone-400' },
}

/** 人可读短锚（与后端 matterShortAnchor 同口径：M-xxxxxxxx） */
function shortAnchor(id: string): string {
  return `M-${id.slice(0, 8)}`
}

/** 等待时长（从 createdAt 起算；方案：板上只有等待时长的事实展示，无时限语义） */
function fmtWaited(createdAt: string, now: number): string {
  const ms = now - new Date(createdAt).getTime()
  if (ms < 0) return ''
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '刚登记'
  if (minutes < 60) return `已等 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `已等 ${hours} 小时`
  const days = Math.floor(hours / 24)
  return `已等 ${days} 天`
}

/** 条目排序：WAITING_PARTNER 置顶（热）→ DONE_PENDING_CONFIRM → WAITING_OTTER / OPEN（辅级） */
const STATE_ORDER: Record<string, number> = {
  WAITING_PARTNER: 0,
  DONE_PENDING_CONFIRM: 1,
  WAITING_OTTER: 2,
  OPEN: 3,
}

/** 面板透传的回执路由通道（index.tsx 的 handleSend mention 路由封装） */
export type MatterRouteFn = (body: string, ownerOtterId: string | null) => void | Promise<void>

/** 主按钮（otter 渐变——采样自 MessageInput 发送键）；次按钮玻璃描边 */
const BTN_PRIMARY =
  'px-2 py-1 rounded-lg text-[10px] font-semibold text-white shadow-sm transition hover:opacity-90 active:scale-95'
const BTN_GHOST =
  'px-2 py-1 rounded-lg text-[10px] font-medium bg-white/40 text-stone-600 border border-white/50 transition hover:bg-white/60 active:scale-95'

/** WAITING_PARTNER 条目按钮组（批准 = otter 渐变主按钮；busy 时整组禁用防重——建议1） */
function WaitingPartnerActions({ onAct, busy }: { onAct: (action: MatterAction) => void; busy?: boolean }) {
  return (
    <div className="flex items-center gap-1 mt-1.5" data-testid="matter-actions-wp">
      <button style={{ background: OTTER_GRADIENT }} className={BTN_PRIMARY} disabled={busy} onClick={() => onAct('approve')}>
        批准
      </button>
      <button className={BTN_GHOST} disabled={busy} onClick={() => onAct('sendback')}>打回</button>
      <button className={BTN_GHOST} disabled={busy} onClick={() => onAct('reject')}>否决</button>
    </div>
  )
}

/** DONE_PENDING_CONFIRM 条目按钮组（确认闭环 = otter 渐变主按钮；busy 时整组禁用防重） */
function ConfirmActions({ onAct, busy }: { onAct: (action: MatterAction) => void; busy?: boolean }) {
  return (
    <div className="flex items-center gap-1 mt-1.5" data-testid="matter-actions-dpc">
      <button style={{ background: OTTER_GRADIENT }} className={BTN_PRIMARY} disabled={busy} onClick={() => onAct('confirm_close')}>
        确认闭环
      </button>
      <button className={BTN_GHOST} disabled={busy} onClick={() => onAct('confirm_sendback')}>打回</button>
    </div>
  )
}

/** 近期闭环区条目（翻案/恢复入口——低频操作，翻案按钮仅 hover/简洁呈现） */
function ClosedItem({ matter, onReopen }: { matter: MatterDTO; onReopen: () => void }) {
  const badge = STATE_BADGE[matter.state] ?? { label: matter.state, className: 'bg-stone-400/15 text-stone-400' }
  // F20261006mlp2 严重2：CLOSED 与 ABANDONED 都可翻案恢复（ABANDONED 曾是永久死路，#1321 收口）
  const reversible = matter.state === 'CLOSED' || matter.state === 'ABANDONED'
  return (
    <div className="px-2.5 py-2 rounded-xl glass-card mb-1.5 opacity-80" data-testid="matter-closed-item">
      <div className="flex items-start gap-1.5">
        <span className="text-[9px] font-mono text-stone-400 mt-0.5 flex-shrink-0">{shortAnchor(matter.id)}</span>
        <span className="text-xs text-stone-500 flex-1 min-w-0 leading-snug line-through decoration-stone-300">
          {matter.title}
        </span>
      </div>
      <div className="flex items-center gap-1.5 mt-1.5">
        <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${badge.className}`}>{badge.label}</span>
        {matter.resolution && (
          <span className="text-[9px] text-stone-400 truncate flex-1" title={matter.resolution}>
            {matter.resolution.length > 40 ? matter.resolution.slice(0, 40) + '…' : matter.resolution}
          </span>
        )}
        {reversible && (
          <button className={`${BTN_GHOST} flex-shrink-0`} onClick={onReopen} title="翻案重开（CLOSED/ABANDONED → OPEN）">
            翻案
          </button>
        )}
      </div>
    </div>
  )
}

function MatterItem({
  matter,
  tickNow,
  busy,
  onAct,
}: {
  matter: MatterDTO
  tickNow: number
  busy?: boolean
  onAct: (matter: MatterDTO, action: MatterAction) => void
}) {
  const badge = STATE_BADGE[matter.state] ?? { label: matter.state, className: 'bg-stone-400/15 text-stone-400' }
  const hot = matter.state === 'WAITING_PARTNER'
  return (
    <div
      data-testid="matter-item"
      className={`px-2.5 py-2 rounded-xl glass-card mb-1.5 ${hot ? 'ring-1 ring-amber-400/40' : ''}`}
    >
      <div className="flex items-start gap-1.5">
        <span className="text-[9px] font-mono text-stone-400 mt-0.5 flex-shrink-0">{shortAnchor(matter.id)}</span>
        <span className="text-xs text-stone-700 flex-1 min-w-0 leading-snug">{matter.title}</span>
      </div>
      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
        <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${badge.className}`}>
          {badge.label}
        </span>
        {matter.level && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-stone-400/10 text-stone-400">{matter.level}</span>
        )}
        <span className="text-[9px] text-stone-400">{fmtWaited(matter.createdAt, tickNow)}</span>
      </div>
      {(matter.waitingFor || matter.ownerOtterId) && (
        <div className="text-[9px] text-stone-400 mt-1 truncate">
          {matter.waitingFor ? `在等：${matter.waitingFor}` : ''}
          {matter.waitingFor && matter.ownerOtterId ? ' · ' : ''}
          {matter.ownerOtterId ? `owner ${matter.ownerOtterId.slice(0, 8)}` : ''}
        </div>
      )}
      {/* F20261008mlp3 P3 严重2修复：板上简报呈现——WAITING_PARTNER 条目展开 payload 简报
          三层结构（§6 吸收语义：卡片被顶走后 matter 兜底，板上看不到简报=兜底残缺）。
          payload 为 JSON 字符串，解析失败降级为原文展示（不阻断面板渲染）。 */}
      {matter.payload && matter.state === 'WAITING_PARTNER' && (
        <MatterBrief payload={matter.payload} />
      )}
      {matter.state === 'WAITING_PARTNER' && (
        <WaitingPartnerActions busy={busy} onAct={action => onAct(matter, action)} />
      )}
      {matter.state === 'DONE_PENDING_CONFIRM' && (
        <ConfirmActions busy={busy} onAct={action => onAct(matter, action)} />
      )}
    </div>
  )
}

/**
 * MatterBrief（F20261008mlp3 P3 严重2修复）：板上简报呈现——payload 简报三层结构。
 * 方案 §6 吸收语义：卡片是 matter 处于 WAITING_PARTNER 态的呈现形态；卡片被顶走后
 * matter 兜底——板上必须能看到简报内容，否则兜底残缺。
 * payload 为 JSON 字符串（P1 准入路径 1 锁定：JSON.stringify({ brief: '...' })），
 * 解析失败降级为原文展示（不阻断面板渲染）。
 */
function MatterBrief({ payload }: { payload: string }) {
  const [expanded, setExpanded] = useState(false)
  let brief: string | null
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>
    brief = typeof parsed.brief === 'string' ? parsed.brief : null
  } catch {
    brief = null
  }
  const display = brief ?? payload
  const preview = display.length > 80 ? display.slice(0, 80) + '…' : display
  return (
    <div className="mt-1.5 pt-1.5 border-t border-stone-200/50" data-testid="matter-brief">
      <button
        className="text-[9px] text-stone-500 hover:text-stone-700 transition text-left w-full"
        onClick={() => setExpanded(!expanded)}
        title={expanded ? '收起简报' : '展开简报全文'}
      >
        <span className="font-medium">简报：</span>
        {expanded ? display : preview}
        {display.length > 80 && (
          <span className="text-stone-400 ml-1">{expanded ? '▲' : '▼'}</span>
        )}
      </button>
    </div>
  )
}

/** 「+」登记入口（准入路径 2——搭档手动登记，initialState=OPEN） */
function RegisterForm({ onRegister }: { onRegister: (title: string) => void }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const submit = () => {
    if (!title.trim()) return
    onRegister(title)
    setTitle('')
    setOpen(false)
  }
  if (!open) {
    return (
      <button
        className="w-full mb-1.5 px-2.5 py-1.5 rounded-xl glass-card text-[10px] text-stone-500 flex items-center justify-center gap-1 hover:bg-white/50 transition"
        onClick={() => setOpen(true)}
        data-testid="matter-register-open"
      >
        <Plus size={11} /> 登记一件事
      </button>
    )
  }
  return (
    <div className="mb-1.5 px-2.5 py-2 rounded-xl glass-card" data-testid="matter-register-form">
      <input
        autoFocus
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setOpen(false); setTitle('') } }}
        placeholder="一句话说清这件事…"
        className="w-full bg-white/50 border border-white/60 rounded-lg px-2 py-1 text-xs text-stone-700 placeholder:text-stone-400 outline-none focus:border-otter-400"
        data-testid="matter-register-input"
      />
      <div className="flex items-center gap-1 mt-1.5">
        <button style={{ background: OTTER_GRADIENT }} className={BTN_PRIMARY} onClick={submit}>
          登记
        </button>
        <button className={BTN_GHOST} onClick={() => { setOpen(false); setTitle('') }}>取消</button>
      </div>
    </div>
  )
}

export function MattersPanel({
  conversationId,
  onRouteToOtter,
}: {
  conversationId: string
  onRouteToOtter?: MatterRouteFn
}) {
  const { matters, loading, recentClosed, pending, act, register } = useMatters(conversationId, onRouteToOtter)
  const [showClosed, setShowClosed] = useState(false)
  /** 走秒时钟复用容器 tickNow 太贵——这里用惰性 Date.now() 渲染即可（30s 轮询驱动重渲染） */
  const tickNow = Date.now()

  const sorted = [...matters].sort((a, b) =>
    (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) ||
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )

  /** tab 角标语义（方案 §5）：只数「等你裁决 + 待你确认闭环」——搭档欠的动作才配叫角标 */
  const partnerActionCount = matters.filter(m =>
    m.state === 'WAITING_PARTNER' || m.state === 'DONE_PENDING_CONFIRM',
  ).length

  return (
    <div className="p-4" data-testid="matters-panel">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 mb-2 flex justify-between items-center">
        <span className="flex items-center gap-1">
          <ClipboardList size={12} />
          待办
          {partnerActionCount > 0 && (
            <span
              data-testid="matter-badge"
              className="ml-0.5 min-w-[16px] h-4 px-1 rounded-full bg-amber-400 text-white text-[9px] font-bold flex items-center justify-center"
            >
              {partnerActionCount}
            </span>
          )}
        </span>
      </h3>
      <RegisterForm onRegister={register} />
      {loading ? (
        <div className="space-y-2">
          <div className="h-16 bg-white/20 rounded-xl animate-pulse" />
          <div className="h-16 bg-white/20 rounded-xl animate-pulse" />
        </div>
      ) : sorted.length === 0 ? (
        <div className="text-[11px] text-stone-400 px-1.5 py-1" data-testid="matter-empty">
          待办板为空——本对话无未闭环事项
        </div>
      ) : (
        <div>
          {sorted.map(m => (
            <MatterItem key={m.id} matter={m} tickNow={tickNow} busy={!!pending[m.id]} onAct={act} />
          ))}
        </div>
      )}

      {recentClosed.length > 0 && (
        <div className="mt-3">
          <button
            className="w-full flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-stone-400 hover:text-stone-600 transition mb-1.5"
            onClick={() => setShowClosed(v => !v)}
            data-testid="matter-closed-toggle"
          >
            {showClosed ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            近期闭环（{recentClosed.length}）
          </button>
          {showClosed && (
            <div>
              {recentClosed.map(m => (
                <ClosedItem key={m.id} matter={m} onReopen={() => act(m, 'reopen')} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
