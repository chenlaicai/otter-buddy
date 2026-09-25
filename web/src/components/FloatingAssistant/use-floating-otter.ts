import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * F20260924wast：浮动獭交互 hook。
 * - 唤起/收起：点击獭、⌘J/Ctrl+J、Esc、点外收起
 * - 拖动：pointer 事件；位移 < 6px 判点击（click 与 drag 分离）
 * - 位置记忆：localStorage（右下角安全区 + 边界 clamp）
 */

const POSITION_KEY = 'floating-otter:position'
/** 拖动位移阈值（px）：小于此值视为点击 */
export const DRAG_THRESHOLD_PX = 6
/** 獭尺寸（px）——位置 clamp 基准 */
const OTTER_SIZE = 56
/** 边缘安全距离（px） */
const EDGE_MARGIN = 8

export interface OtterPosition { x: number; y: number }

/** 读取记忆位置（无记忆时 null = 右下角默认） */
export function loadOtterPosition(): OtterPosition | null {
  try {
    const raw = localStorage.getItem(POSITION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { x?: number; y?: number }
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null
    return { x: parsed.x, y: parsed.y }
  } catch {
    return null
  }
}

/** 位置 clamp：保持獭在视口内（resize 后重入也安全） */
export function clampPosition(pos: OtterPosition): OtterPosition {
  const x = Math.min(Math.max(pos.x, EDGE_MARGIN), window.innerWidth - OTTER_SIZE - EDGE_MARGIN)
  const y = Math.min(Math.max(pos.y, EDGE_MARGIN), window.innerHeight - OTTER_SIZE - EDGE_MARGIN)
  return { x, y }
}

export function saveOtterPosition(pos: OtterPosition) {
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify(pos))
  } catch { /* 隐私模式等场景静默 */ }
}

/** 默认位置：右下角（原型对齐：right 24 / bottom 24 安全区） */
export function defaultOtterPosition(): OtterPosition {
  return {
    x: window.innerWidth - OTTER_SIZE - 24,
    y: window.innerHeight - OTTER_SIZE - 24,
  }
}

export interface UseFloatingOtterResult {
  open: boolean
  setOpen: (v: boolean) => void
  toggle: () => void
  position: OtterPosition
  /** 拖动中（拖动态抑制点击判定与 hover 气泡） */
  dragging: boolean
  /** pointer 事件 handlers（挂到獭本体元素） */
  bindDrag: {
    onPointerDown: (e: React.PointerEvent) => void
  }
  /** 全局键盘/点外 handlers（挂到面板与 document） */
  bindGlobal: {
    onKeyDown: (e: React.KeyboardEvent) => void
    onPanelPointerDown: (e: React.PointerEvent) => void
  }
}

/** 默认快捷键字母（settings 页可改，localStorage floating-otter:hotkey） */
export const HOTKEY_STORAGE_KEY = 'floating-otter:hotkey'

function hotkeyLetter(): string {
  try {
    return (localStorage.getItem(HOTKEY_STORAGE_KEY) || 'j').toLowerCase()
  } catch {
    return 'j'
  }
}

/** ⌘+letter / Ctrl+letter 命中判定（导出供单测；letter 可配置） */
export function matchesToggleHotkey(e: KeyboardEvent | React.KeyboardEvent, letter: string = hotkeyLetter()): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === letter
}

export function useFloatingOtter(): UseFloatingOtterResult {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<OtterPosition>(() => loadOtterPosition() ?? defaultOtterPosition())
  const [dragging, setDragging] = useState(false)
  const dragStateRef = useRef<{ startX: number; startY: number; origin: OtterPosition; moved: boolean } | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // ⌘J 全局监听（capture 阶段——避免输入框 stopPropagation 吞掉）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (matchesToggleHotkey(e)) {
        e.preventDefault()
        setOpen(v => !v)
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true } as EventListenerOptions)
  }, [])

  // Esc 收起（面板内优先；面板未聚焦时也收）
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // 点外收起：pointerdown 落在面板与獭之外 → 收起
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      // 獭本体（data-floating-otter 标记）不算外部
      if (target instanceof Element && target.closest('[data-floating-otter]')) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // 拖动：pointerdown 记起点 → move 阈值外更新位置 → up 时按位移判定 click/drag
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    dragStateRef.current = { startX: e.clientX, startY: e.clientY, origin: position, moved: false }
    setDragging(true)
  }, [position])

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const st = dragStateRef.current
      if (!st) return
      const dx = e.clientX - st.startX
      const dy = e.clientY - st.startY
      if (!st.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      st.moved = true
      setPosition(clampPosition({ x: st.origin.x + dx, y: st.origin.y + dy }))
    }
    function onUp() {
      const st = dragStateRef.current
      dragStateRef.current = null
      setDragging(false)
      if (st?.moved) saveOtterPosition(positionRef.current)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  const positionRef = useRef(position)
  positionRef.current = position

  const toggle = useCallback(() => setOpen(v => !v), [])

  const bindDrag = { onPointerDown }
  const bindGlobal = {
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    },
    onPanelPointerDown: () => { /* 面板内按下不冒泡处理（点外收起由 document listener 判定） */ },
  }

  return { open, setOpen, toggle, position, dragging, bindDrag, bindGlobal }
}
