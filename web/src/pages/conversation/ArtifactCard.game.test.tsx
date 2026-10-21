// @vitest-environment jsdom
/**
 * F20261021gmbe：ArtifactCard game 型渲染测试。
 *
 * 覆盖：
 * 1. 折叠态：游戏徽章 + 房间号 + 「展开玩」入口，无 iframe（E4 折叠不挂载）
 * 2. 展开：iframe 挂载（src/sandbox 口径）+ 收起/放大操作
 * 3. 收起：iframe 卸载（断 SSE 生命周期）
 * 4. 放大：modal 全屏面板（内联位让位，单实例）
 * 5. 外部 URL 降级：不内嵌，退化为「摘要卡+新窗口」（E5）
 * 6. 非 game 型回归：url 型卡不受影响
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ArtifactCard } from './ArtifactCard'
import type { LocalLinkedResource } from '../../lib/mappers'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function makeResource(overrides: Partial<LocalLinkedResource>): LocalLinkedResource {
  return {
    id: 'res-1',
    type: 'game',
    url: '/mahjong/room-abc',
    title: '三麻对局',
    content: null,
    category: null,
    flagged: false,
    auto: true,
    status: 'active',
    ...overrides,
  }
}

async function render(resource: LocalLinkedResource) {
  await act(async () => {
    root.render(<ArtifactCard resource={resource} pinned={false} onTogglePin={() => {}} />)
  })
}

function click(testId: string) {
  const el = container.querySelector(`[data-testid="${testId}"]`)
  if (!el) throw new Error(`[data-testid="${testId}"] not found`)
  return act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

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

describe('ArtifactCard game 型（F20261021gmbe）', () => {
  it('折叠态：游戏徽章 + 房间号 + 展开玩入口，无 iframe', async () => {
    await render(makeResource({}))
    const card = container.querySelector('[data-artifact-id="res-1"]')!
    expect(card.textContent).toContain('游戏')
    expect(card.textContent).toContain('房间 room-abc')
    expect(card.querySelector('[data-testid="game-expand"]')).not.toBeNull()
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('展开：iframe 挂载（白名单 src + sandbox 口径），出现收起/放大', async () => {
    await render(makeResource({}))
    await click('game-expand')
    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe!.getAttribute('src')).toBe('/mahjong/room-abc')
    expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin')
    expect(container.querySelector('[data-testid="game-collapse"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="game-enlarge"]')).not.toBeNull()
  })

  it('收起：iframe 卸载（收起即断 SSE）', async () => {
    await render(makeResource({}))
    await click('game-expand')
    expect(container.querySelector('iframe')).not.toBeNull()
    await click('game-collapse')
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('放大：modal 面板挂载到 body（portal），内联位让位保持单 iframe', async () => {
    await render(makeResource({}))
    await click('game-expand')
    await click('game-enlarge')
    const iframes = document.querySelectorAll('iframe')
    expect(iframes.length).toBe(1)
    // Modal 走 createPortal 挂 document.body——查 document 而非 container
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('外部 URL 降级：不内嵌（无展开玩/无 iframe），保留摘要卡 + 新窗口打开', async () => {
    await render(makeResource({ url: 'http://evil.com/mahjong/x' }))
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('[data-testid="game-expand"]')).toBeNull()
    const card = container.querySelector('[data-artifact-id="res-1"]')!
    const link = card.querySelector('a[target="_blank"]')
    expect(link).not.toBeNull()
    expect(link!.getAttribute('href')).toBe('http://evil.com/mahjong/x')
  })

  it('穿越 URL 降级：/mahjong/../api 不内嵌', async () => {
    await render(makeResource({ url: '/mahjong/../api' }))
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('[data-testid="game-expand"]')).toBeNull()
  })

  it('非 game 型回归：url 型卡照旧（摘要 + 新窗口，无 game 分支）', async () => {
    await render(makeResource({ type: 'url', url: 'https://example.com/doc', title: '外部文档' }))
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('[data-testid="game-expand"]')).toBeNull()
    const link = container.querySelector('a[target="_blank"]')
    expect(link!.getAttribute('href')).toBe('https://example.com/doc')
  })
})
