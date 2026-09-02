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

/**
 * #510（F20260901mftz）：打开中的 Modal 栈——模块级，所有 Modal 实例共享。
 * Why: 多 Modal 叠加（Modal 内开 Modal）时，每个实例都往 document 挂 keydown，
 * focus trap 的 Tab 循环互相拉扯、Escape 同时关闭全部。栈建立层级意识：
 * 只有栈顶实例响应 Tab 循环和 Escape，非栈顶静默。
 * 焦点归还（prevActive?.focus()）天然正确：顶层打开时记录的焦点就在次层 Modal 内。
 */
const modalStack: number[] = []
let nextModalId = 1

/** 实例是否为栈顶（含幂等重入保护：非栈顶实例不响应键盘） */
function isStackTop(id: number): boolean {
  return modalStack[modalStack.length - 1] === id
}

export const Modal = memo(function Modal({ isOpen = true, onClose, title, children, footer, width = '440px', fullScreenOnMobile }: ModalProps) {
  /** #510: 栈登记 id——组件挂载期稳定（memo 下重渲染不变），open 时 push，卸载/close 时移除 */
  const stackIdRef = useRef<number | null>(null)

  useEffect(() => {
    if (!isOpen) return
    const id = nextModalId++
    stackIdRef.current = id
    modalStack.push(id)

    const handler = (e: KeyboardEvent) => {
      /** #510: 只有栈顶响应 Escape——叠加时非栈顶实例静默，避免连锁关闭 */
      if (e.key === 'Escape' && isStackTop(id)) onClose()
    }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
      const idx = modalStack.indexOf(id)
      if (idx !== -1) modalStack.splice(idx, 1)
      stackIdRef.current = null
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

  /* F20260826pfix + F20260831wsui：桌面高度上限恒给，不因 fullScreenOnMobile 丢失。
   *  滚动上限已 token 化（--modal-scroll-max-h / --modal-content-max-h），
   *  值定义在 globals.css @theme 块，此处通过 CSS 变量恒引用。
   *  窄屏全屏抽屉由 CSS modal-fs-mobile 类 @media (max-width: 639px)
   *  的 !important 100dvh 兜底，无需 JS 侧条件置 undefined。 */

  /** F20260826pfix：焦点管理（可及性）——打开时焦点进入弹窗（关闭按钮），
   *  关闭时归还触发元素。简单 focus trap：Tab 循环限制在 dialog 内。
   *  #510：非栈顶实例的 trap 静默——Tab 由栈顶全权接管，杜绝循环拉扯。 */
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!isOpen) return
    const prevActive = document.activeElement as HTMLElement | null
    closeBtnRef.current?.focus()
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !dialogRef.current) return
      /** #510: 只在栈顶时接管 Tab——非栈顶 Modal 的 dialog 不可见/不可交互 */
      if (!isStackTop(stackIdRef.current ?? -1)) return
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
        style={{ width, maxHeight: 'var(--modal-scroll-max-h)' }}
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
        <div className={`p-5 overflow-y-auto ${fullScreenOnMobile ? 'modal-fs-content' : ''}`} style={{ maxHeight: 'var(--modal-content-max-h)' }}>
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
