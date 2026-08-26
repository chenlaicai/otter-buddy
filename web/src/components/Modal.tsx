import { type ReactNode, useEffect, memo } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { OTTER_GRADIENT } from '../lib/otter-colors'

interface ModalProps {
  /** 不传则视为常开（调用方按需挂载组件的场景） */
  isOpen?: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  width?: string
  /** 窄屏（<640px）时全屏抽屉式布局 */
  fullScreenOnMobile?: boolean
}

export const Modal = memo(function Modal({ isOpen = true, onClose, title, children, footer, width = '440px', fullScreenOnMobile }: ModalProps) {
  useEffect(() => {
    if (isOpen) {
      const handler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') onClose()
      }
      document.addEventListener('keydown', handler)
      return () => document.removeEventListener('keydown', handler)
    }
  }, [isOpen, onClose])

  /** F20260825scrf：body.modal-open 声明期 = Modal 打开期——配合 globals.css 冻结
   *  shimmer 动画；配合 index.tsx 的渲染冻结（SSE batch/轮询暂停）使 scrim 的
   *  backdrop 采样源准静态，根治流式期间清晰↔模糊交替。多重弹窗共存安全：
   *  仅当 body 里无其它 scrim 时才移除 */
  useEffect(() => {
    if (!isOpen) return
    document.body.classList.add('modal-open')
    return () => {
      if (!document.querySelector('body > .scrim')) document.body.classList.remove('modal-open')
    }
  }, [isOpen])

  if (!isOpen) return null

  /** F20260825scrf：Portal 挂 body——scrim 脱离页面组件树（事件冒泡与布局上下文
   *  解耦）。注：backdrop-filter 的采样语义跨 DOM 子树（scrim 仍采样页面内容位图），
   *  冻结闪烁的真正机制是弹窗期三源渲染冻结，Portal 是结构清理（检视 A-1 更正） */
  return createPortal(
    <>
    {fullScreenOnMobile && <style>{`
      @media (max-width: 639px) {
        .modal-fs-mobile {
          width: 100vw !important;
          height: 100dvh !important;
          max-height: 100dvh !important;
          margin: 0 !important;
          border-radius: 0 !important;
        }
        .modal-fs-mobile .modal-fs-content {
          max-height: calc(100dvh - 104px) !important;
        }
      }
    `}</style>}
    <div
      className="fixed inset-0 scrim flex items-center justify-center z-[100]"
      onClick={onClose}
    >
      <div
        className={`glass-overlay rounded-3xl overflow-hidden ${fullScreenOnMobile ? 'modal-fs-mobile' : ''}`}
        style={{ width, maxHeight: fullScreenOnMobile ? undefined : '80vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-white/40 flex justify-between items-center">
          <span className="text-sm font-semibold text-stone-700">{title}</span>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-600 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/40 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className={`p-5 overflow-y-auto ${fullScreenOnMobile ? 'modal-fs-content' : ''}`} style={fullScreenOnMobile ? undefined : { maxHeight: 'calc(80vh - 120px)' }}>
          {children}
        </div>
        {footer && (
          <div className="px-5 py-3 border-t border-white/40 flex justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
    </>,
    document.body
  )
})

/** Button styles for modal footer */
export function ModalButton({
  children,
  onClick,
  variant = 'secondary',
  disabled,
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
}) {
  const base = 'px-4 py-2 text-sm rounded-xl transition'
  const styles = {
    primary: 'text-white shadow-glow',
    secondary: 'glass-card text-stone-600 hover:bg-white/50',
    danger: 'text-white bg-red-400 hover:bg-red-500',
  }
  const style = variant === 'primary'
    ? { ...{ background: OTTER_GRADIENT } }
    : undefined

  return (
    <button className={`${base} ${styles[variant]} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`} onClick={onClick} style={style} disabled={disabled}>
      {children}
    </button>
  )
}
