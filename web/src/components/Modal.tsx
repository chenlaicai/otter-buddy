import { type ReactNode, useEffect, memo, useRef } from 'react'
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

  /** F20260826pfix：桌面高度上限不再因 fullScreenOnMobile 丢失。
   *  Why: 原实现 fullScreenOnMobile=true 时 dialog maxHeight 与内容区上限
   *  双双置 undefined，而 modal-fs-content 的 max-height 只在
   *  @media (max-width: 639px) 生效——桌面端弹窗无任何高度约束，
   *  海獭面板工具袋展开（40+ chips）后弹窗无限长高、footer 出屏、无滚动。
   *  修法：JS 侧上限恒给 80vh（CSS 类只在 <640px 覆盖为 100dvh 全屏抽屉），
   *  prop 语义收窄为「窄屏全屏化」，桌面行为与普通 Modal 一致。 */
  const dialogMaxHeight = '80vh'
  const contentMaxHeight = 'calc(80vh - 120px)'

  /** F20260826pfix：焦点管理（可及性）——打开时焦点进入弹窗（关闭按钮），
   *  关闭时归还触发元素。简单 focus trap：Tab 循环限制在 dialog 内。 */
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!isOpen) return
    const prevActive = document.activeElement as HTMLElement | null
    closeBtnRef.current?.focus()
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !dialogRef.current) return
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      prevActive?.focus()
    }
  }, [isOpen])

  if (!isOpen) return null

  /** F20260825scrf：Portal 挂 body——scrim 脱离页面组件树（事件冒泡与布局上下文
   *  解耦）。注：backdrop-filter 的采样语义跨 DOM 子树（scrim 仍采样页面内容位图），
   *  冻结闪烁的真正机制是弹窗期三源渲染冻结，Portal 是结构清理（检视 A-1 更正） */
  return createPortal(
    <div
      className="fixed inset-0 scrim flex items-center justify-center z-[100]"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`glass-overlay rounded-3xl overflow-hidden ${fullScreenOnMobile ? 'modal-fs-mobile' : ''}`}
        style={{ width, maxHeight: dialogMaxHeight }}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-white/40 flex justify-between items-center">
          <span className="text-sm font-semibold text-stone-700">{title}</span>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            className="text-stone-400 hover:text-stone-600 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/40 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className={`p-5 overflow-y-auto ${fullScreenOnMobile ? 'modal-fs-content' : ''}`} style={{ maxHeight: contentMaxHeight }}>
          {children}
        </div>
        {footer && (
          <div className={`px-5 py-3 border-t border-white/40 flex justify-end gap-2 ${fullScreenOnMobile ? 'modal-fs-footer' : ''}`}>
            {footer}
          </div>
        )}
      </div>
    </div>,
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
