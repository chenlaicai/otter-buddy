import { useState, useRef, useEffect } from 'react'
import { ArrowUp, Paperclip, X, FileText } from 'lucide-react'
import type { LocalOtter as Otter } from '../../lib/mappers'
import { getOtterColor, OTTER_GRADIENT } from '../../lib/otter-colors'
import { useDraftCache } from '../../hooks/use-draft-cache'
import { ATTACHMENT_ACCEPT, MAX_IMAGES_PER_SEND, MAX_FILES_PER_UPLOAD, fmtBytes } from '../../lib/attachments'
import type { StagedAttachment, UploadErrorInfo } from './hooks/useAttachmentStaging'
import { MagicWordHelp } from './MagicWordHelp'

interface MessageInputProps {
  onSend: (text: string, mentionOtterIds?: string[], attachments?: StagedAttachment[]) => void
  disabled: boolean
  placeholder?: string
  otters: Otter[]
  conversationId: string | null
  /** 多模态 Phase 1：附件中转区状态与操作（提升到 ChatView 层以随发送流转） */
  staged: StagedAttachment[]
  onRemoveAttachment: (id: string) => void
  onPickFiles: (files: File[]) => void
  uploadError?: UploadErrorInfo | null
  onDismissUploadError?: () => void
}

export function MessageInput({ onSend, disabled, placeholder = '输入消息... Enter 发送, @ 提及小獭', otters, conversationId, staged, onRemoveAttachment, onPickFiles, uploadError, onDismissUploadError }: MessageInputProps) {
  const { draft, saveDraft, clearDraft } = useDraftCache(conversationId)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** 会话切换时清空 file input 的选择状态（受控组件不受 React 管理的部分） */
  useEffect(() => {
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [conversationId])

  /** 附件携带时允许空文本发送（纯图/纯文件消息），与纯文本发送互斥条件分开判定 */
  const canSend = !disabled && (draft.trim().length > 0 || staged.some(s => !s.uploading))

  /** 自动高度：随内容增长，封顶 140px，超出后内部滚动 */
  function autoResize() {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value
    saveDraft(val)
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

  /** 从文本提取所有 @提及（支持末尾、标点、多 @） */
  function extractMentions(text: string): string[] {
    const mentions: string[] = []
    /** 匹配 @名字：名字 = 非空白且非中文标点的连续字符，后接空白/中文标点/字符串结尾 */
    const regex = /@([^\s，。！？、；：''（）【】《》\u3000]+)(?=[\s，。！？、；：''（）【】《》\u3000]|$)/g
    let match
    while ((match = regex.exec(text)) !== null) {
      mentions.push(match[1])
    }
    return mentions
  }

  function handleSend() {
    if (!canSend) return

    // Check for @mention（支持多 @、末尾无空格、标点分隔）
    const mentionNames = extractMentions(draft)
    const mentionIds = mentionNames
      .map(name => otters.find(o => o.name === name)?.id)
      .filter((id): id is string => !!id)

    const readyAttachments = staged.filter(s => !s.uploading)
    onSend(draft, mentionIds.length > 0 ? mentionIds : undefined, readyAttachments.length > 0 ? readyAttachments : undefined)
    clearDraft()
    setMentionQuery(null)
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
    })
  }

  function insertMention(name: string) {
    const cp = textareaRef.current?.selectionStart ?? draft.length
    const before = draft.substring(0, cp)
    const after = draft.substring(cp)
    const match = before.match(/@(\w*)$/)
    if (match) {
      const newVal = before.substring(0, match.index) + '@' + name + ' ' + after
      saveDraft(newVal)
      const newPos = (match.index ?? 0) + name.length + 2
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        textareaRef.current?.setSelectionRange(newPos, newPos)
      })
    }
    setMentionQuery(null)
  }

  /** 多模态 Phase 2：剪贴板粘贴文件（微信式体验）——从 paste 事件提取文件走同一上传管线。
   *  仅拦截含文件的粘贴；纯文本粘贴（含截图工具自动写入的文本 URL）走原生行为不打断。 */
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (files.length === 0) return // 纯文本粘贴：原生行为
    e.preventDefault()
    onPickFiles(files)
  }

  /** 多模态 Phase 2：拖拽文件进输入框（与粘贴同管线）。拖文本/链接走原生 */
  function handleDrop(e: React.DragEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return
    e.preventDefault()
    onPickFiles(files)
  }

  /** 按 ID 去重，避免同名 otter 重复显示 */
  const seen = new Set<string>()
  const uniqueOtters = otters.filter(o => { if (seen.has(o.id)) return false; seen.add(o.id); return true })
  const filteredOtters = mentionQuery !== null
    ? uniqueOtters.filter(o => o.name.toLowerCase().includes(mentionQuery))
    : []
  const stagedImageCount = staged.filter(s => s.kind === 'image').length

  return (
    <div className="px-1 pb-5 pt-2 flex-shrink-0">
      <div className="mx-auto relative">
        {/* Mention autocomplete */}
        {mentionQuery !== null && filteredOtters.length > 0 && (
          <div className="absolute bottom-16 left-1/2 -translate-x-1/2 glass-overlay rounded-2xl p-1 z-50 min-w-[180px]">
            {filteredOtters.map(o => {
              const color = getOtterColor(o.id)
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

        {/* 附件中转区：缩略图/文件卡 + 移除按钮；上传中半透明+loading 态 */}
        {(staged.length > 0 || uploadError) && (
          <div className="mb-2 flex flex-wrap gap-2 px-1">
            {staged.map(s => (
              <div key={s.id} className={`relative group rounded-xl glass-card p-1.5 flex items-center gap-2 ${s.uploading ? 'opacity-60' : ''}`}>
                {s.kind === 'image' ? (
                  <img
                    src={s.localPreviewUrl || `/api/attachments/${s.id}`}
                    alt={s.originalName}
                    className="w-12 h-12 rounded-lg object-cover"
                  />
                ) : (
                  <div className="w-12 h-12 rounded-lg bg-white/60 flex items-center justify-center">
                    <FileText className="w-5 h-5 text-stone-400" />
                  </div>
                )}
                <div className="max-w-[140px]">
                  <div className="text-[11px] text-stone-600 truncate">{s.originalName}</div>
                  <div className="text-[10px] text-stone-400">{s.uploading ? '上传中...' : fmtBytes(s.sizeBytes)}</div>
                </div>
                <button
                  onClick={() => onRemoveAttachment(s.id)}
                  className="w-4 h-4 rounded-full bg-stone-400/80 text-white flex items-center justify-center absolute -top-1.5 -right-1.5 opacity-0 group-hover:opacity-100 transition"
                  aria-label={`移除 ${s.originalName}`}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
            {uploadError && (
              <div className="flex items-center gap-2 rounded-xl bg-red-50/80 border border-red-200/60 px-3 py-1.5 text-[11px] text-red-600 max-w-full" title={uploadError.message}>
                {uploadError.status !== null && <span className="flex-shrink-0 font-mono text-[10px] text-red-400">{uploadError.status}</span>}
                <span className="truncate">{uploadError.message}</span>
                {onDismissUploadError && (
                  <button onClick={onDismissUploadError} className="flex-shrink-0 font-medium hover:text-red-700">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex items-end gap-2 glass-input rounded-3xl px-4 py-2.5 transition">
          {/* 多模态 Phase 1：附件选择入口。图片数已达上限仍允许选（可选中文档），后端注入前还会硬校验 */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || staged.length >= MAX_FILES_PER_UPLOAD}
            className="w-8 h-8 rounded-2xl flex items-center justify-center text-stone-400 hover:text-stone-600 hover:bg-white/40 transition flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed mb-0.5"
            aria-label="添加附件"
            title={`附件（图片≤${MAX_IMAGES_PER_SEND}张/轮，单次≤${MAX_FILES_PER_UPLOAD}个）`}
          >
            <Paperclip className="w-4 h-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              if (files.length > 0) onPickFiles(files)
              e.target.value = '' // 允许重复选择同一文件
            }}
          />
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={(e) => {
              // 拖文件时允许 drop（阻止浏览器默认打开文件）；纯文本拖拽不影响
              if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
            }}
            disabled={disabled}
            placeholder={placeholder}
            className="flex-1 bg-transparent text-sm text-stone-700 placeholder-stone-400 resize-none outline-none min-h-[24px] max-h-[var(--input-scroll-max-h)] leading-relaxed disabled:opacity-50 overflow-y-auto"
          />
          <MagicWordHelp />
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="w-9 h-9 rounded-2xl text-white flex items-center justify-center shadow-glow transition flex-shrink-0 disabled:opacity-50"
            style={{ background: OTTER_GRADIENT }}
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        </div>
        <p className="text-[10px] text-stone-400 text-center mt-1.5">
          Enter 发送 · Shift+Enter 换行 · @ 提及小獭{stagedImageCount > 0 ? ` · 已选图片 ${stagedImageCount}/${MAX_IMAGES_PER_SEND}` : ''}
        </p>
      </div>
    </div>
  )
}
