import type { OtterMood } from './global-conversation-store'

/**
 * F20260924wast：浮动獭本体（纯展示 + 交互回调）。
 * datu 像素头像三态（只加装饰不动脸）：
 * - sleep 睡觉：呼吸（scale 1→1.03）+ zZ 气泡
 * - look 张望：左右探头（rotate ±6°）
 * - bubble 冒泡：红点（未读数）+ 轻跳
 * 位置/拖动状态由宿主（FloatingAssistant）经 props 注入——獭与面板共享同一份。
 * F20260928waf1 P2：hover 快捷气泡（三条「随便问点什么」）移除——实测反馈多余，
 * 交互简化为「点击獭=开面板」，无中间层
 */

const MOOD_LABEL: Record<OtterMood, string> = {
  sleep: '睡觉（全空闲）',
  look: '张望（有活跃任务）',
  bubble: '冒泡（有未读）',
}

export interface FloatingOtterProps {
  mood: OtterMood
  /** 冒泡态红点数字（未读总数，>99 显示 99+） */
  unreadCount: number
  open: boolean
  /** 点击獭（点击/拖动分离已在宿主完成——这里只收「确定为点击」的回调） */
  onToggle: () => void
  position: { x: number; y: number }
  dragging: boolean
  onPointerDown: (e: React.PointerEvent) => void
}

export function FloatingOtter(props: FloatingOtterProps) {
  const { mood, unreadCount, open, onToggle, position, dragging, onPointerDown } = props

  return (
    <div
      data-floating-otter
      data-testid="floating-otter"
      data-mood={mood}
      aria-label={`浮动獭（${MOOD_LABEL[mood]}）`}
      className="fixed z-50 select-none touch-none"
      style={{ left: position.x, top: position.y, width: 56, height: 56 }}
      onPointerDown={onPointerDown}
    >
      {/* 獭本体（点击=展开/收起；拖动位移<6px 判点击由宿主 dragging 状态抑制） */}
      <button
        type="button"
        data-testid="floating-otter-avatar"
        onClick={() => { if (!dragging) onToggle() }}
        className={`relative w-14 h-14 rounded-2xl bg-white/80 backdrop-blur border border-white/60 shadow-lg
          transition-transform duration-200 hover:scale-105 active:scale-95 cursor-pointer
          ${mood === 'sleep' ? 'animate-otter-breathe' : ''}
          ${mood === 'look' ? 'animate-otter-peek' : ''}
          ${mood === 'bubble' ? 'animate-otter-hop' : ''}
          ${dragging ? 'cursor-grabbing scale-105' : ''}`}
      >
        <img src="/avatars/datu.svg" alt="" draggable={false} className="w-11 h-11 mx-auto pointer-events-none" />
        {/* 冒泡红点 */}
        {mood === 'bubble' && (
          <span
            data-testid="floating-otter-unread-badge"
            className="absolute -top-1.5 -right-1.5 min-w-[20px] h-5 px-1 rounded-full bg-red-500 text-white
              text-[11px] font-semibold flex items-center justify-center shadow"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
        {/* 睡觉 zZ（面板展开时不显示——獭已醒） */}
        {mood === 'sleep' && !open && (
          <span className="absolute -top-2 right-0 text-stone-400 text-xs font-bold animate-otter-zz" aria-hidden>zZ</span>
        )}
      </button>
    </div>
  )
}

export default FloatingOtter
