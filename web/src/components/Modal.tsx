import { type ReactNode, useEffect } from 'react'
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
}

export function Modal({ isOpen = true, onClose, title, children, footer, width = '440px' }: ModalProps) {
  useEffect(() => {
    if (isOpen) {
      const handler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') onClose()
      }
      document.addEventListener('keydown', handler)
      return () => document.removeEventListener('keydown', handler)
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black/10 backdrop-blur-sm flex items-center justify-center z-[100]"
      onClick={onClose}
    >
      <div
        className="glass-strong rounded-3xl shadow-otter-lg overflow-hidden"
        style={{ width, maxHeight: '80vh' }}
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
        <div className="p-5 overflow-y-auto" style={{ maxHeight: 'calc(80vh - 120px)' }}>
          {children}
        </div>
        {footer && (
          <div className="px-5 py-3 border-t border-white/40 flex justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

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
