// @vitest-environment jsdom
/**
 * F20261021gmbe：GameEmbedPanel 单测——同源白名单校验 + iframe 挂载/加载态。
 *
 * 覆盖：
 * 1. resolveGameEmbedPath：白名单通过（同源牌局路由）+ 路径穿越/外部 URL 拒绝 5 用例
 * 2. GameEmbedPanel：白名单内挂载 iframe（sandbox="allow-scripts allow-same-origin"）、
 *    加载态遮罩、onLoad 后就绪；白名单外降级提示块（不挂 iframe）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GameEmbedPanel, resolveGameEmbedPath, GAME_EMBED_LOAD_TIMEOUT_MS } from './GameEmbedPanel'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
})

describe('resolveGameEmbedPath 同源白名单（F20261021gmbe 安全边界第 1 层）', () => {
  it('白名单内：同源牌局路由通过，返回规范化 pathname', () => {
    expect(resolveGameEmbedPath('/mahjong/room-abc_123')).toBe('/mahjong/room-abc_123')
    expect(resolveGameEmbedPath('/mahjong/9f8e7d6c')).toBe('/mahjong/9f8e7d6c')
  })

  it('穿越用例 1：/mahjong/../api 规范化出白名单 → 拒绝', () => {
    expect(resolveGameEmbedPath('/mahjong/../api')).toBeNull()
  })

  it('穿越用例 2：/mahjong/a/b 多段（非全匹配）→ 拒绝', () => {
    expect(resolveGameEmbedPath('/mahjong/a/b')).toBeNull()
  })

  it('穿越用例 3：%2e%2e 编码点段规范化出白名单 → 拒绝', () => {
    expect(resolveGameEmbedPath('/mahjong/%2e%2e/api')).toBeNull()
    expect(resolveGameEmbedPath('/mahjong/%2e%2e')).toBeNull()
  })

  it('穿越用例 4：反斜杠变体 /\\mahjong → 拒绝（不给规范化机会）', () => {
    expect(resolveGameEmbedPath('/\\mahjong')).toBeNull()
    expect(resolveGameEmbedPath('/\\mahjong/x')).toBeNull()
  })

  it('穿越用例 5：绝对 URL http://evil.com/mahjong/x → 拒绝', () => {
    expect(resolveGameEmbedPath('http://evil.com/mahjong/x')).toBeNull()
    expect(resolveGameEmbedPath('https://evil.com/mahjong/x')).toBeNull()
  })

  it('附加拒绝：协议相对 //evil.com、javascript: 协议、空值', () => {
    expect(resolveGameEmbedPath('//evil.com/mahjong/x')).toBeNull()
    expect(resolveGameEmbedPath('javascript:alert(1)')).toBeNull()
    expect(resolveGameEmbedPath(null)).toBeNull()
    expect(resolveGameEmbedPath('')).toBeNull()
  })

  it('拒绝：根路径/无房间段/其他本应用路由（白名单未接入一律降级）', () => {
    expect(resolveGameEmbedPath('/mahjong')).toBeNull()
    expect(resolveGameEmbedPath('/mahjong/')).toBeNull()
    expect(resolveGameEmbedPath('/api/mahjong/rooms')).toBeNull()
    expect(resolveGameEmbedPath('/')).toBeNull()
  })
})

describe('GameEmbedPanel 组件（F20261021gmbe）', () => {
  it('白名单内：挂载 iframe，src=白名单 pathname，sandbox 锁死 allow-scripts allow-same-origin', async () => {
    await act(async () => {
      root.render(<GameEmbedPanel url="/mahjong/room-1" title="三麻对局" />)
    })
    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe!.getAttribute('src')).toBe('/mahjong/room-1')
    // E1 定稿口径：sandbox 属性必须存在且双值齐全（delta 已锁死）
    expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin')
    expect(iframe!.getAttribute('title')).toBe('三麻对局')
    // 加载态遮罩在 onLoad 前可见
    expect(container.querySelector('[data-testid="game-embed-loading"]')).not.toBeNull()
  })

  it('onLoad 后：加载态遮罩移除（ready）', async () => {
    await act(async () => {
      root.render(<GameEmbedPanel url="/mahjong/room-1" title="三麻对局" />)
    })
    const iframe = container.querySelector('iframe')!
    await act(async () => {
      iframe.dispatchEvent(new Event('load'))
    })
    expect(container.querySelector('[data-testid="game-embed-loading"]')).toBeNull()
    expect(container.querySelector('[data-testid="game-embed-panel"]')).not.toBeNull()
  })

  it('白名单外（外部 URL）：不挂 iframe，降级提示块 + 新窗口链接', async () => {
    await act(async () => {
      root.render(<GameEmbedPanel url="http://evil.com/mahjong/x" title="钓鱼牌桌" />)
    })
    expect(container.querySelector('iframe')).toBeNull()
    const blocked = container.querySelector('[data-testid="game-embed-blocked"]')
    expect(blocked).not.toBeNull()
    const link = blocked!.querySelector('a')
    expect(link!.getAttribute('href')).toBe('http://evil.com/mahjong/x')
    expect(link!.getAttribute('target')).toBe('_blank')
  })

  it('加载超时：15s 无 onLoad → 错误态（超时探针），重试重建 iframe', async () => {
    // React 19 对 iframe 不接 onError（error 事件仅 img/source/media）——
    // 错误态由超时探针驱动，非 onError（发现于实现期 react-dom-client 排查）
    vi.useFakeTimers()
    try {
      await act(async () => {
        root.render(<GameEmbedPanel url="/mahjong/room-1" title="三麻对局" />)
      })
      await act(async () => {
        vi.advanceTimersByTime(GAME_EMBED_LOAD_TIMEOUT_MS + 1)
      })
      expect(container.querySelector('[data-testid="game-embed-error"]')).not.toBeNull()
      const retry = container.querySelector('[data-testid="game-embed-error"] button')!
      await act(async () => {
        retry.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      // 重试：新 iframe 挂载（key=attempt 强制重建），错误态消失，超时探针重新计时
      expect(container.querySelector('[data-testid="game-embed-error"]')).toBeNull()
      expect(container.querySelector('iframe')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
