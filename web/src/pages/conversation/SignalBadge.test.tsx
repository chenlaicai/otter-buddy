// @vitest-environment jsdom
/**
 * F20260826mwrd C4：SignalBadge 徽章测试——三态渲染 + 点击展开 + halt 高亮。
 *
 * 母方案 Part 5 验收：pending（橙）→ resolved（绿，显示裁决摘要）/ dismissed（灰，显示理由）；
 * objection/blocked 常规徽章点击展开 payload；halt 高亮显示「已执行」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SignalBadge } from './SignalBadge'
import type { LocalMessageSignal } from '../../lib/mappers'

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

function makeSignal(overrides: Partial<LocalMessageSignal> = {}): LocalMessageSignal {
  return {
    id: 'sig-1',
    type: 'objection',
    severity: 'medium',
    status: 'pending',
    payload: '与母方案锚点冲突（F20260826mwrd.md:86）',
    fromOtterId: 'otter-small-1',
    createdAt: '2026-08-27T10:00:00.000Z',
    ...overrides,
  }
}

describe('SignalBadge 三态渲染（母方案 Part 5 状态机）', () => {
  it('pending objection：⚡ 未裁决（橙），默认不展开 payload', () => {
    act(() => { root.render(<SignalBadge signal={makeSignal()} />) })
    const badge = container.querySelector('[data-testid="signal-badge"]')!
    expect(badge.textContent).toContain('objection')
    expect(badge.textContent).toContain('未裁决')
    expect(badge.textContent).not.toContain('F20260826mwrd.md:86') // 未展开
    expect(badge.querySelector('button')!.className).toContain('amber')
  })

  it('点击展开 payload 正文 + 时间戳', () => {
    act(() => { root.render(<SignalBadge signal={makeSignal()} />) })
    act(() => { container.querySelector('button')!.click() })
    expect(container.textContent).toContain('F20260826mwrd.md:86')
    expect(container.textContent).toContain('2026-08-27T10:00:00.000Z')
  })

  it('resolved：绿徽章 + 裁决摘要可见', () => {
    act(() => {
      root.render(<SignalBadge signal={makeSignal({
        status: 'resolved',
        resolution: '锚点核实成立，已改派',
        resolvedBy: 'otter-big',
      })} />)
    })
    const badge = container.querySelector('[data-testid="signal-badge"]')!
    expect(badge.textContent).toContain('已裁决')
    expect(badge.querySelector('button')!.className).toContain('emerald')
  })

  it('dismissed：灰徽章 + 驳回', () => {
    act(() => {
      root.render(<SignalBadge signal={makeSignal({
        status: 'dismissed',
        resolution: '锚点无法核实',
      })} />)
    })
    const badge = container.querySelector('[data-testid="signal-badge"]')!
    expect(badge.textContent).toContain('已驳回')
    expect(badge.querySelector('button')!.className).toContain('stone')
  })

  it('halt：红色高亮 + 已执行（非已裁决）+ 展开含目标', () => {
    act(() => {
      root.render(<SignalBadge signal={makeSignal({
        type: 'halt',
        status: 'resolved',
        resolvedBy: 'system',
        resolution: 'halt 指令已在目标獭下一个工具调用边界注入',
        targetName: '开发獭-C1',
      })} fromName="大獭" />)
    })
    const badge = container.querySelector('[data-testid="signal-badge"]')!
    expect(badge.textContent).toContain('halt')
    expect(badge.textContent).toContain('已执行')
    expect(badge.querySelector('button')!.className).toContain('red')
    act(() => { container.querySelector('button')!.click() })
    expect(container.textContent).toContain('开发獭-C1')
  })

  it('blocked：🚧 徽章', () => {
    act(() => {
      root.render(<SignalBadge signal={makeSignal({ type: 'blocked', payload: '环境故障，已试：重启/换分支' })} />)
    })
    expect(container.querySelector('[data-testid="signal-badge"]')!.textContent).toContain('blocked')
  })
})
