// @vitest-environment jsdom
/**
 * F20260924wast：浮动獭测试。
 * 覆盖：三态推断优先级（冒泡 > 张望 > 睡觉）、快捷键命中判定（含可配置）、
 * 拖动位移 < 6px 判点击（阈值纯函数）、位置持久化 round-trip。
 */
import { describe, it, expect } from 'vitest'
import { inferMood } from './global-conversation-store'
import {
  matchesToggleHotkey, loadOtterPosition, saveOtterPosition, clampPosition, DRAG_THRESHOLD_PX,
} from './use-floating-otter'
import type { LocalConversation } from '../../lib/mappers'

function conv(overrides: Partial<LocalConversation> = {}): LocalConversation {
  return {
    id: 'c1', title: 't', status: 'active', pinned: false, otterIds: [],
    ...overrides,
  } as LocalConversation
}

describe('三态推断（优先级：冒泡 > 张望 > 睡觉）', () => {
  it('全空闲 → 睡觉', () => {
    expect(inferMood([conv(), conv()])).toBe('sleep')
  })

  it('有未读 → 冒泡（优先级最高——即使同时有活跃任务）', () => {
    expect(inferMood([
      conv({ activityStatus: 'processing' }),
      conv({ unreadCount: 2 }),
    ])).toBe('bubble')
  })

  it('有活跃对话无未读 → 张望', () => {
    expect(inferMood([conv({ activityStatus: 'processing' })])).toBe('look')
  })

  it('awaiting_user 不算张望（张望 = processing 精确口径）', () => {
    expect(inferMood([conv({ activityStatus: 'awaiting_user' })])).toBe('sleep')
  })

  it('空列表 → 睡觉', () => {
    expect(inferMood([])).toBe('sleep')
  })
})

describe('快捷键命中（⌘/Ctrl + 可配置字母）', () => {
  const mk = (over: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ key: 'j', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over }) as KeyboardEvent

  it('⌘J / Ctrl+J 命中', () => {
    expect(matchesToggleHotkey(mk({ metaKey: true }))).toBe(true)
    expect(matchesToggleHotkey(mk({ ctrlKey: true }))).toBe(true)
  })

  it('无修饰键 / Alt / Shift 不命中', () => {
    expect(matchesToggleHotkey(mk({}))).toBe(false)
    expect(matchesToggleHotkey(mk({ metaKey: true, altKey: true }))).toBe(false)
    expect(matchesToggleHotkey(mk({ metaKey: true, shiftKey: true }))).toBe(false)
  })

  it('可配置字母：⌘K 在 hotkey=k 时命中', () => {
    expect(matchesToggleHotkey(mk({ metaKey: true, key: 'k' }), 'k')).toBe(true)
    expect(matchesToggleHotkey(mk({ metaKey: true, key: 'j' }), 'k')).toBe(false)
  })
})

describe('拖动阈值与位置持久化', () => {
  it('阈值 = 6px（原型对齐）', () => {
    expect(DRAG_THRESHOLD_PX).toBe(6)
  })

  it('位置 save/load round-trip + 坏数据回退 null', () => {
    saveOtterPosition({ x: 100, y: 200 })
    expect(loadOtterPosition()).toEqual({ x: 100, y: 200 })
    localStorage.setItem('floating-otter:position', 'not-json')
    expect(loadOtterPosition()).toBeNull()
    localStorage.removeItem('floating-otter:position')
    expect(loadOtterPosition()).toBeNull()
  })

  it('clampPosition 保持獭在视口内', () => {
    // jsdom 视口 1024×768
    expect(clampPosition({ x: -50, y: -50 })).toEqual({ x: 8, y: 8 })
    const clamped = clampPosition({ x: 5000, y: 5000 })
    expect(clamped.x).toBeLessThanOrEqual(1024 - 8)
    expect(clamped.y).toBeLessThanOrEqual(768 - 8)
  })
})
