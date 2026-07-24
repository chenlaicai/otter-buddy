import { useState, useRef } from 'react'
import { ArrowUp } from 'lucide-react'
import type { LocalOtter as Otter } from '../../lib/mappers'
import { getOtterColor, OTTER_GRADIENT } from '../../lib/otter-colors'

interface MessageInputProps {
  onSend: (text: string, mentionOtterId?: string) => void
  disabled: boolean
  placeholder?: string
  otters: Otter[]
}

export function MessageInput({ onSend, disabled, placeholder = '输入消息... Enter 发送, @ 提及小獭', otters }: MessageInputProps) {
  const [value, setValue] = useState('')
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /** 自动高度：随内容增长，封顶 140px，超出后内部滚动 */
  function autoResize() {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value
    setValue(val)
    autoResize()

    // Detect @mention
    const cp = e.target.selectionStart
    const before = val.substring(0, cp)
    const match = before.match(/@(\w*)$/)
    if (match) {
      setMentionQuery(match[1].toLowerCase())
    } else {
      setMentionQuery(null)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleSend() {
    if (!value.trim() || disabled) return

    // Check for @mention
    const mentionMatch = value.match(/@(\S+)\s/)
    let mentionId: string | undefined
    if (mentionMatch) {
      const mentioned = otters.find(o => o.name === mentionMatch[1])
      if (mentioned) mentionId = mentioned.id
    }

    onSend(value, mentionId)
    setValue('')
    setMentionQuery(null)
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
    })
  }

  function insertMention(name: string) {
    const cp = textareaRef.current?.selectionStart ?? value.length
    const before = value.substring(0, cp)
    const after = value.substring(cp)
    const match = before.match(/@(\w*)$/)
    if (match) {
      const newVal = before.substring(0, match.index) + '@' + name + ' ' + after
      setValue(newVal)
      const newPos = (match.index ?? 0) + name.length + 2
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        textareaRef.current?.setSelectionRange(newPos, newPos)
      })
    }
    setMentionQuery(null)
  }

  /** 按 ID 去重，避免同名 otter 重复显示 */
  const seen = new Set<string>()
  const uniqueOtters = otters.filter(o => { if (seen.has(o.id)) return false; seen.add(o.id); return true })
  const filteredOtters = mentionQuery !== null
    ? uniqueOtters.filter(o => o.name.toLowerCase().includes(mentionQuery))
    : []

  return (
    <div className="px-6 pb-5 pt-2 flex-shrink-0">
      <div className="max-w-[780px] mx-auto relative">
        {/* Mention autocomplete */}
        {mentionQuery !== null && filteredOtters.length > 0 && (
          <div className="absolute bottom-16 left-1/2 -translate-x-1/2 glass-strong rounded-2xl shadow-otter-lg p-1 z-50 min-w-[180px]">
            {filteredOtters.map(o => {
              const color = getOtterColor(o.id, o.ci)
              return (
                <div
                  key={o.id}
                  onClick={() => insertMention(o.name)}
                  className="px-2.5 py-1.5 rounded-xl text-xs cursor-pointer hover:bg-white/40 flex items-center gap-2"
                >
                  <div
                    className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
                    style={{ background: color.gradient }}
                  >
                    {o.name.charAt(0)}
                  </div>
                  <span className="text-stone-600">{o.name}</span>
                </div>
              )
            })}
          </div>
        )}

        <div className="flex items-end gap-2 glass-input rounded-3xl px-4 py-2.5 transition">
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder={placeholder}
            className="flex-1 bg-transparent text-sm text-stone-700 placeholder-stone-400 resize-none outline-none min-h-[24px] max-h-[140px] leading-relaxed disabled:opacity-50 overflow-y-auto"
          />
          <button
            onClick={handleSend}
            disabled={disabled || !value.trim()}
            className="w-9 h-9 rounded-2xl text-white flex items-center justify-center shadow-glow transition flex-shrink-0 disabled:opacity-50"
            style={{ background: OTTER_GRADIENT }}
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        </div>
        <p className="text-[10px] text-stone-400 text-center mt-1.5">
          Enter 发送 · Shift+Enter 换行 · @ 提及小獭
        </p>
      </div>
    </div>
  )
}
