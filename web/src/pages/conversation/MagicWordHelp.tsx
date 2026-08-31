import { useState, useRef, useEffect } from 'react'
import { HelpCircle } from 'lucide-react'

/**
 * F20260831mmwh：输入框旁 Magic Word 问号弹层。
 * 点击「?」图标显示 magic word 词表浮层，再点击或点外部关闭。
 *
 * 词表数据硬编码（2 词，与 .pi/SYSTEM.md Magic Words 段同步维护）。
 */

/** 同步自 .pi/SYSTEM.md Magic Words 段（词表冻结 2 词，2026-08-26） */
const MAGIC_WORDS = [
  {
    keyword: '「停下」',
    behavior: '全场急停：所有海獭停止新增副作用（不发新命令、不写新文件、不 push），当前工具调用收尾后汇报状态，等你指示。',
  },
  {
    keyword: '「绕路了」',
    behavior: '方向重审：停止当前动作，审视方案是否走了捷径/局部最优，画出直达终态的路径。',
  },
] as const

export function MagicWordHelp() {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  return (
    <div ref={wrapperRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-8 h-8 rounded-2xl flex items-center justify-center text-stone-400 hover:text-stone-600 hover:bg-white/40 transition mb-0.5"
        aria-label="Magic Word 帮助"
        aria-expanded={open}
      >
        <HelpCircle className="w-4 h-4" />
      </button>
      {open && (
        <div
          className="absolute bottom-10 right-0 w-64 glass-overlay rounded-2xl p-3 z-50"
          data-testid="magic-word-popover"
        >
          <p className="text-xs font-medium text-stone-600 mb-2">Magic Words（手动拉闸词）</p>
          <div className="space-y-2">
            {MAGIC_WORDS.map(w => (
              <div key={w.keyword}>
                <span className="text-xs font-semibold text-otter-600">{w.keyword}</span>
                <p className="text-[11px] text-stone-500 leading-relaxed">{w.behavior}</p>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-stone-400 mt-2 border-t border-stone-200/60 pt-1.5">
            在对话中输入以上关键词，海獭会立即响应。
          </p>
        </div>
      )}
    </div>
  )
}
