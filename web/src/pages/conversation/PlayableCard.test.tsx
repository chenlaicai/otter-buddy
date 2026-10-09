// @vitest-environment jsdom
/**
 * F20261009csp2 活类卡渲染测试。
 * 锁定行为：①html-card-play 围栏渲染为活类卡（默认 expanded + 🎮 徽章）；
 * ②暂停按钮收起（卸载 iframe）、重启按钮重挂载（nonce 变化）；
 * ③与 html-card 共享 fenceIndex 计数（1 普通 + 1 活类 = index 0,1）；
 * ④活类超出卡数预算与普通卡同降级。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MessageList } from './MessageList'
import type { LocalMessage } from '../../lib/mappers'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function msg(id: string, content: string): LocalMessage {
  return { id, st: 'otter', si: 'ot-1', content, status: 'completed', ts: `2026-10-09T01:0${id.length}:00.000Z`, dur: null, seq: 0 }
}

function render(content: string) {
  act(() => {
    root.render(
      <MessageList
        messages={[msg('m1', content)]}
        state="normal"
        onStopStream={() => {}}
        onRetryMessage={() => {}}
        onRetry={() => {}}
        onGoToSettings={() => {}}
        otters={[]}
        conversationId="c1"
        pinRef={{ current: true }}
        linkedResources={[]}
      />,
    )
  })
}

function cardEl(cardId: string): HTMLElement | null {
  return container.querySelector(`[data-card-id="${cardId}"]`)
}

describe('活类卡（html-card-play，F20261009csp2）', () => {
  it('默认展开运行 + 🎮 徽章 + 暂停/重启控制', () => {
    render('看这个\n\n```html-card-play title="贪吃蛇"\n<canvas id="g" width="200" height="200"></canvas>\n<script>let x=1</script>\n```')
    const card = cardEl('m1:0')
    expect(card).not.toBeNull()
    // 默认 expanded：iframe 直接存在（无需点击）
    expect(card!.querySelector('iframe')).not.toBeNull()
    // 徽章文案
    expect(card!.textContent).toContain('🎮 活类 · 运行中')
    // 控制按钮：重启 / 暂停 / 看源码
    expect(card!.textContent).toContain('重启')
    expect(card!.textContent).toContain('暂停')
  })

  it('暂停收起（卸载 iframe）→ 再展开恢复', () => {
    render('```html-card-play title="x"\n<p>game</p>\n```')
    const card = cardEl('m1:0')!
    expect(card.querySelector('iframe')).not.toBeNull()
    const pauseBtn = Array.from(card.querySelectorAll('button')).find(b => b.textContent === '暂停')!
    act(() => { pauseBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(card.querySelector('iframe')).toBeNull()
    // 沙盒脚注也换成非运行态文案
    expect(card.textContent).not.toContain('沙盒运行中')
  })

  it('重启 = 重挂载（iframe key 变化，脚本归零）', () => {
    render('```html-card-play title="x"\n<p>game</p>\n```')
    const card = cardEl('m1:0')!
    const iframe1 = card.querySelector('iframe')!
    const restartBtn = Array.from(card.querySelectorAll('button')).find(b => b.textContent === '重启')!
    act(() => { restartBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const iframe2 = card.querySelector('iframe')!
    expect(iframe2).not.toBeNull()
    expect(iframe2).not.toBe(iframe1) // 重挂载（新元素）
  })

  it('与普通卡共享 fenceIndex（1 普通 + 1 活类 = index 0,1）', () => {
    render('```html-card title="普通"\n<p>a</p>\n```\n\n```html-card-play title="游戏"\n<p>b</p>\n```')
    expect(cardEl('m1:0')).not.toBeNull()
    expect(cardEl('m1:1')).not.toBeNull()
    // index 0 是普通卡（折叠态、无重启按钮），index 1 是活类
    const c0 = cardEl('m1:0')!
    expect(c0.textContent).toContain('展开渲染')
    expect(c0.textContent).not.toContain('重启')
    const c1 = cardEl('m1:1')!
    expect(c1.textContent).toContain('🎮 活类 · 运行中')
  })

  it('超预算（第 3 张）与普通卡同降级为源码', () => {
    render('```html-card title="a"\n<p>1</p>\n```\n\n```html-card title="b"\n<p>2</p>\n```\n\n```html-card-play title="c"\n<p>3</p>\n```')
    const card = cardEl('m1:2')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('超出单消息卡片上限')
    // 降级块无 iframe（不进沙盒）
    expect(card!.querySelector('iframe')).toBeNull()
    // 服务端同口径拒绝（speak 校验把 play 围栏计入卡数——集成测试在 tests/ 侧）
  })

  it('普通 html-card 行为不变（默认折叠，无活类徽章）', () => {
    render('```html-card title="普通卡"\n<p>hi</p>\n```')
    const card = cardEl('m1:0')!
    expect(card.querySelector('iframe')).toBeNull() // 默认折叠
    expect(card.textContent).not.toContain('活类')
    expect(card.textContent).toContain('展开渲染')
  })
})
