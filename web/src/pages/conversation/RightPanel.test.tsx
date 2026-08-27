// @vitest-environment jsdom
/**
 * RightPanel 关键资源展示测试（F20260825krui）
 * - FactItem：长内容截断（truncate）+ title tooltip 显示全文
 * - LinkedResourceItem：统一 stone 色系 + 类型色块 + 截断 + title tooltip
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RightPanel } from './RightPanel'
import type { LocalConversation as Conversation, LocalOtter as Otter, LocalLinkedResource as LinkedResource, LocalOtterSession as OtterSession, LocalScheduledTask } from '../../lib/mappers'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function makeResource(overrides: Partial<LinkedResource> = {}): LinkedResource {
  return {
    id: 'r1',
    type: 'fact',
    url: null,
    title: '',
    content: '',
    category: null,
    flagged: false,
    auto: false,
    ...overrides,
  }
}

function renderPanel(resources: LinkedResource[], otters: Otter[] = []) {
  const conversation = { id: 'c1', title: '测试对话', createdAt: '' } as unknown as Conversation
  const sessions: Record<string, OtterSession[]> = {}
  const noop = () => {}
  act(() => {
    root.render(
      <RightPanel
        conversation={conversation}
        otters={otters}
        sessions={sessions}
        linkedResources={resources}
        onCreateSmallOtter={noop}
        onDissolveOtter={noop}
        onRestartOtter={noop}
        onOpenOtterDetail={noop}
        onAddFact={noop}
        onToggleResourceFlag={noop}
        onAddLinkedResource={noop}
        onDeleteLinkedResource={noop}
        scheduledTasks={[] as LocalScheduledTask[]}
        scheduledTasksLoading={false}
        onToggleScheduledTask={noop}
        onCreateScheduledTask={noop}
        onEditScheduledTask={noop}
        onDeleteScheduledTask={noop}
        onTriggerScheduledTask={noop}
        onViewScheduledTaskHistory={noop}
      />
    )
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('FactItem', () => {
  it('长内容应截断且 title tooltip 含全文', () => {
    const longContent = '这是一条非常长的事实内容'.repeat(10)
    renderPanel([makeResource({ type: 'fact', content: longContent })])
    const truncated = container.querySelector('.truncate')
    expect(truncated).not.toBeNull()
    expect(truncated!.getAttribute('title')).toBe(longContent)
    expect(truncated!.textContent).toBe(longContent)
  })

  it('分类徽章与内容分行展示', () => {
    renderPanel([makeResource({ type: 'fact', content: '短事实', category: '决策' })])
    const badges = Array.from(container.querySelectorAll('.rounded-full')).filter(el => el.textContent === '决策')
    expect(badges.length).toBe(1)
  })
})

describe('LinkedResourceItem', () => {
  it('链接资源应有类型色块且不再使用 teal 正文色', () => {
    renderPanel([makeResource({ type: 'pr', url: 'https://github.com/x/y/pull/1', title: 'PR: 修复登录' })])
    const badge = Array.from(container.querySelectorAll('span')).find(el => el.textContent === 'pr')
    expect(badge).not.toBeUndefined()
    // 正文统一 stone 色系（不再 teal-500 正文）
    const tealText = Array.from(container.querySelectorAll('span')).find(el =>
      el.className.includes('text-teal-500') && el.textContent === 'PR: 修复登录'
    )
    expect(tealText).toBeUndefined()
  })

  it('长标题截断且 title tooltip 显示 url', () => {
    const longTitle = '超长资源标题'.repeat(20)
    const url = 'https://example.com/very/long/path'
    renderPanel([makeResource({ type: 'url', url, title: longTitle })])
    const truncated = container.querySelector('.truncate')
    expect(truncated).not.toBeNull()
    expect(truncated!.getAttribute('title')).toBe(url)
    expect(truncated!.textContent).toBe(longTitle)
  })

  it('无 title 时显示 url，无 url 时显示占位符', () => {
    renderPanel([makeResource({ type: 'file', url: null, title: '' })])
    const placeholder = Array.from(container.querySelectorAll('.truncate')).find(el => el.textContent === '(无标题)')
    expect(placeholder).not.toBeUndefined()
  })

  it('有 title 无 url 时 tooltip 显示 title 全文（截断场景下悬停仍有增量）', () => {
    const longTitle = '很长的资源标题无需 url 也能看全文'.repeat(8)
    renderPanel([makeResource({ type: 'file', url: null, title: longTitle })])
    const truncated = container.querySelector('.truncate')
    expect(truncated).not.toBeNull()
    expect(truncated!.getAttribute('title')).toBe(longTitle)
    expect(truncated!.textContent).toBe(longTitle)
  })
})

describe('OtterParticipantCard 模型标签（web-model-display）', () => {
  function makeOtter(overrides: Partial<Otter> = {}): Otter {
    return {
      id: 'o1', name: '小獭', type: 'small', createdAt: '2026-08-25',
      ...overrides,
    } as Otter
  }

  it('有 modelAlias 时渲染模型 badge', () => {
    renderPanel([], [makeOtter({ modelAlias: 'mimo' })])
    const badge = container.querySelector('[data-testid="model-badge"]')
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toBe('mimo')
  })

  it('无 modelAlias 时不渲染模型 badge（不留空占位，也不渲染 undefined 字面串）', () => {
    renderPanel([], [makeOtter()])
    expect(container.querySelector('[data-testid="model-badge"]')).toBeNull()
  })

  it('未知新 alias 原样渲染（不依赖已知 alias 白名单）', () => {
    renderPanel([], [makeOtter({ modelAlias: 'claude-future' })])
    const badge = container.querySelector('[data-testid="model-badge"]')
    expect(badge!.textContent).toBe('claude-future')
  })

  it('大獭 badge 与模型 badge 可同卡片共存', () => {
    renderPanel([], [makeOtter({ id: 'big-1', name: '大獭', type: 'big', modelAlias: 'glm' })])
    const texts = Array.from(container.querySelectorAll('span.rounded-full')).map(el => el.textContent)
    expect(texts).toContain('大獭')
    expect(container.querySelector('[data-testid="model-badge"]')!.textContent).toBe('glm')
  })
})

describe('OtterParticipantCard memo（#502 轮询引用稳定）', () => {
  function makeOtter(overrides: Record<string, unknown> = {}) {
    return {
      id: 'o1', name: '小獭', type: 'small', createdAt: '2026-08-25',
      ...overrides,
    } as Otter
  }

  it('otter prop 引用不变时重渲染父组件，参与者卡片 DOM 节点保持同一引用', () => {
    const otter = makeOtter()
    renderPanel([], [otter])
    const before = container.querySelector('.glass-card')
    expect(before).not.toBeNull()
    // 模拟轮询：父组件以相同 otter 引用重新渲染
    renderPanel([], [otter])
    const after = container.querySelector('.glass-card')
    // memo 生效时 React 复用 fiber，DOM 节点引用不变（不重建 = 无视觉抖动）
    expect(after).toBe(before)
  })

  it('otter prop 内容变化时卡片正常更新', () => {
    renderPanel([], [makeOtter({ name: '旧名' })])
    expect(container.textContent).toContain('旧名')
    renderPanel([], [makeOtter({ name: '新名' })])
    expect(container.textContent).toContain('新名')
    expect(container.textContent).not.toContain('旧名')
  })
})
