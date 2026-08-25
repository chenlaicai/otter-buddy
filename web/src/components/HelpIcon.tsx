import { useState, useRef, useEffect } from 'react'
import { HelpCircle } from 'lucide-react'

/** 属性说明弹出框（? 图标，D2.1）
 *  点击弹出说明气泡（触屏友好），再点图标或点外部关闭。
 *  说明内容 = 该属性的「本质」：是什么、怎么算的、数据从哪来。 */
export function HelpIcon({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [open])

  return (
    <span ref={ref} className="relative inline-flex items-center ml-1">
      <button
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        className="text-stone-400 hover:text-stone-600 transition"
        aria-label="属性说明"
      >
        <HelpCircle size={14} />
      </button>
      {open && (
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-60 glass-overlay rounded-xl p-3 text-xs text-stone-600 leading-relaxed z-50 shadow-bubble"
          onClick={e => e.stopPropagation()}
        >
          {text}
        </div>
      )}
    </span>
  )
}
