import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { HelpCircle } from 'lucide-react'

/** 属性说明弹出框（? 图标，D2.1）
 *  点击弹出说明气泡（触屏友好），再点图标或点外部关闭。
 *  说明内容 = 该属性的「本质」：是什么、怎么算的、数据从哪来。
 *
 *  F20260826pfix: 气泡改 Portal + fixed 按钮坐标定位。
 *  Why: 原 absolute + bottom-full 方案在 Modal 的 overflow-hidden /
 *  内容区 overflow-y-auto 双重剪裁下被截断（面板双栏每栏 ~260px，
 *  240px 气泡从栏首 ? 图标弹出必然溢出弹窗边缘，用户看不全）。
 *  Portal 挂 body 脱离所有 overflow 上下文；坐标按按钮 getBoundingClientRect
 *  实时计算并 clamp 到视口内，任何布局下完整可见。 */
export function HelpIcon({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  /** 气泡 fixed 坐标（按钮 rect 计算后写入，渲染帧内生效） */
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    if (!open) return
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [open])

  /** 打开时计算气泡位置：按钮上方居中，视口四边 clamp（含安全边距 8px） */
  useEffect(() => {
    if (!open || !ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const BUBBLE_W = 240
    const MARGIN = 8
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - BUBBLE_W / 2, MARGIN),
      window.innerWidth - BUBBLE_W - MARGIN,
    )
    // 默认按钮上方（mb-2 语义保留为 8px 间距）；顶部放不下时翻到下方
    const above = rect.top - 8
    const BUBBLE_EST_H = 96
    const top = above - BUBBLE_EST_H < MARGIN ? rect.bottom + 8 : above
    setPos({ left, top })
  }, [open])

  const bubbleId = ref.current ? `help-${ref.current.dataset.hid ?? (ref.current.dataset.hid = Math.random().toString(36).slice(2, 8))}` : undefined

  return (
    <span ref={ref} className="relative inline-flex items-center ml-1">
      <button
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        className="text-stone-400 hover:text-stone-600 transition"
        aria-label="属性说明"
        aria-expanded={open}
        aria-describedby={open ? bubbleId : undefined}
      >
        <HelpCircle size={14} />
      </button>
      {open && pos && createPortal(
        <div
          id={bubbleId}
          role="tooltip"
          className="fixed w-60 glass-overlay rounded-xl p-3 text-xs text-stone-600 leading-relaxed z-[120] shadow-bubble"
          style={{ left: pos.left, top: pos.top }}
          onClick={e => e.stopPropagation()}
        >
          {text}
        </div>,
        document.body,
      )}
    </span>
  )
}
