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

function renderPanel(resources: LinkedResource[]) {
  const conversation = { id: 'c1', title: '测试对话', createdAt: '' } as unknown as Conversation
  const otters: Otter[] = []
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
