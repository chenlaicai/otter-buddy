import { ClipboardList } from 'lucide-react'
import type { MatterDTO } from '../../api/client'
import { useMatters } from './hooks/useMatters'

/**
 * F20261005mtlp P1：右侧栏「待办」tab——只读最小板。
 *
 * P1 范围（方案 §7）：列出 open 事项（标题/状态徽章/等待时长/owner），不可操作。
 * 裁决仍走对话直复（通道 A），状态由獭用 transition_matter 工具迁移；
 * 板上操作按钮（通道 B）在 P2。
 *
 * 样式严格沿用现有 tab 体系（glass 面板、区块标题、玻璃卡条目），不自造风格。
 */

/** 状态徽章文案与配色（沿用面板 stone/teal/amber 色系） */
const STATE_BADGE: Record<string, { label: string; className: string }> = {
  WAITING_PARTNER: { label: '待你裁决', className: 'bg-amber-400/15 text-amber-600' },
  DONE_PENDING_CONFIRM: { label: '待确认闭环', className: 'bg-teal-400/15 text-teal-600' },
  WAITING_OTTER: { label: '獭处理中', className: 'bg-stone-400/15 text-stone-500' },
  OPEN: { label: '待认领', className: 'bg-stone-400/15 text-stone-400' },
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

function MatterItem({ matter, tickNow }: { matter: MatterDTO; tickNow: number }) {
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
    </div>
  )
}

export function MattersPanel({ conversationId }: { conversationId: string }) {
  const { matters, loading } = useMatters(conversationId)
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
            <MatterItem key={m.id} matter={m} tickNow={tickNow} />
          ))}
        </div>
      )}
    </div>
  )
}
