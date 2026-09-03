import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { HelpCircle } from 'lucide-react'

/** 属性说明弹出框（? 图标，D2.1）
 *  点击弹出说明气泡（触屏友好），再点图标或点外部关闭。
 *  说明内容 = 该属性的「本质」：是什么、怎么算的、数据从哪来。
 *  F20260903：text 放宽为 ReactNode——健康页五维雷达的公式说明是结构化列表
 *  （逐维度公式行），纯 string 装不下；字符串用法不变，兼容全部既有调用点。
 *
 *  F20260826pfix: 气泡改 Portal + fixed 按钮坐标定位。
 *  Why: 原 absolute + bottom-full 方案在 Modal 的 overflow-hidden /
 *  内容区 overflow-y-auto 双重剪裁下被截断（面板双栏每栏 ~260px，
 *  240px 气泡从栏首 ? 图标弹出必然溢出弹窗边缘，用户看不全）。
 *  Portal 挂 body 脱离所有 overflow 上下文；坐标按按钮 getBoundingClientRect
 *  实时计算并 clamp 到视口内，任何布局下完整可见。 */
export function HelpIcon({ text }: { text: React.ReactNode }) {
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

  /** 打开时计算气泡位置：按钮上方居中，视口四边 clamp（含安全边距 8px）。
   *  F20260826pfix 审视发现4：高度不用估算值——首帧渲染后 useLayoutEffect
   *  读实际 offsetHeight 二次 clamp，长文本气泡底部不会被视口截断 */
  useEffect(() => {
    if (!open || !ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const BUBBLE_W = 240
    const MARGIN = 8
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - BUBBLE_W / 2, MARGIN),
      window.innerWidth - BUBBLE_W - MARGIN,
    )
    // 默认按钮上方；顶部放不下时翻到下方
    const above = rect.top - 8
    const top = above < MARGIN ? rect.bottom + 8 : above
    setPos({ left, top })
  }, [open])

  const bubbleRef = useRef<HTMLDivElement>(null)
  /** 二次 clamp：按实际高度修正（首帧已渲染但未 paint，视觉无跳动） */
  useLayoutEffect(() => {
    if (!open || !pos || !bubbleRef.current) return
    const h = bubbleRef.current.offsetHeight
    const MARGIN = 8
    setPos(p => {
      if (!p) return p
      return p.top + h > window.innerHeight - MARGIN
        ? { left: p.left, top: Math.max(MARGIN, window.innerHeight - h - MARGIN) }
        : p
    })
  }, [open, pos])

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
          ref={bubbleRef}
          id={bubbleId}
          role="tooltip"
          className="fixed w-60 max-h-[60vh] overflow-y-auto glass-overlay rounded-xl p-3 text-xs text-stone-600 leading-relaxed z-[120] shadow-bubble"
          style={{ left: pos.left, top: pos.top }}
          /* 审视发现2：Portal 后气泡不在 ref 子树内，mousedown 必须在气泡上阻止冒泡，
             否则 document 级 handleOutside 先于 click 关闭气泡——用户无法选中复制文案 */
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        >
          {text}
        </div>,
        document.body,
      )}
    </span>
  )
}
