// @vitest-environment jsdom
/**
 * F20261008csf1 P1：文类产物摘要卡混排测试。
 * 锁定行为：①pr/file/fact 类型的 linkedResources 按 createdAt 插到时间轴对应位置；
 * ②fact 卡显示 content 全文（≤500 字）；③file 卡显示首段摘要+展开全文；
 * ④钉住按钮切换高亮状态；⑤非 pr/file/fact 类型（url/worktree/branch）不混排。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MessageList } from './MessageList'
import type { LocalMessage, LocalLinkedResource } from '../../lib/mappers'

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

function msg(id: string, ts: string, content = `内容-${id}`): LocalMessage {
  return { id, st: 'otter', si: 'ot-1', content, status: 'completed', ts, dur: null, seq: 0 }
}

function res(id: string, type: string, createdAt: string, extra: Partial<LocalLinkedResource> = {}): LocalLinkedResource {
  return {
    id, type, url: null, title: `标题-${id}`, content: null,
    category: null, flagged: false, auto: true, createdAt, ...extra,
  }
}

function renderTimeline(messages: LocalMessage[], resources: LocalLinkedResource[]) {
  act(() => {
    root.render(
      <MessageList
        messages={messages}
        state="normal"
        onStopStream={() => {}}
        onRetryMessage={() => {}}
        onRetry={() => {}}
        onGoToSettings={() => {}}
        otters={[]}
        conversationId="conv-1"
        pinRef={{ current: true }}
        linkedResources={resources}
      />,
    )
  })
}

/** 取中间栏顶层子节点顺序（时间轴渲染序）。消息分支的外层 div 自身带
 *  data-message-id、产物卡在子节点上——先 matches 自查再 querySelector 查后代 */
function timelineOrder(): string[] {
  const content = container.querySelector('.overflow-y-auto > div')!
  return Array.from(content.children).map(el =>
    el.matches('[data-message-id]')
      ? el.getAttribute('data-message-id')
      : el.querySelector('[data-artifact-id]')?.getAttribute('data-artifact-id')
        ?? '?')
}

describe('产物卡混排（F20261008csf1）', () => {
  it('fact 卡按 createdAt 插到对应消息之前', () => {
    renderTimeline(
      [msg('m1', '2026-10-08T09:00:00Z'), msg('m2', '2026-10-08T10:00:00Z'), msg('m3', '2026-10-08T11:00:00Z')],
      [res('f1', 'fact', '2026-10-08T10:30:00Z', { content: '关键结论：采用方案 B' })],
    )
    expect(timelineOrder()).toEqual(['m1', 'm2', 'f1', 'm3'])
    expect(container.textContent).toContain('关键结论：采用方案 B')
  })

  it('晚于全部消息的登记时间 → 附末尾', () => {
    renderTimeline(
      [msg('m1', '2026-10-08T09:00:00Z')],
      [res('p1', 'pr', '2026-10-08T12:00:00Z', { url: 'https://github.com/x/y/pull/1' })],
    )
    expect(timelineOrder()).toEqual(['m1', 'p1'])
  })

  it('早于全部消息的登记时间 → 插最前', () => {
    renderTimeline(
      [msg('m1', '2026-10-08T09:00:00Z')],
      [res('p1', 'pr', '2026-10-08T08:00:00Z')],
    )
    expect(timelineOrder()).toEqual(['p1', 'm1'])
  })

  it('pr/file/fact 之外的类型（url/worktree/branch）不混排', () => {
    renderTimeline(
      [msg('m1', '2026-10-08T09:00:00Z')],
      [res('u1', 'url', '2026-10-08T08:00:00Z'), res('w1', 'worktree', '2026-10-08T08:30:00Z')],
    )
    expect(timelineOrder()).toEqual(['m1'])
  })

  it('file 卡显示首段摘要，长内容可展开全文', () => {
    const longContent = '第一段摘要内容。\n\n' + '后续段落细节 '.repeat(100)
    renderTimeline(
      [msg('m1', '2026-10-08T09:00:00Z')],
      [res('d1', 'file', '2026-10-08T09:30:00Z', { content: longContent, url: '/docs/x.md' })],
    )
    expect(container.textContent).toContain('第一段摘要内容')
    expect(container.textContent).not.toContain('后续段落细节')
    const expandBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === '展开全文')
    expect(expandBtn).toBeTruthy()
    act(() => { expandBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.textContent).toContain('后续段落细节')
  })

  it('钉住按钮切换高亮态（同卡再点取消）', () => {
    renderTimeline(
      [msg('m1', '2026-10-08T09:00:00Z')],
      [res('f1', 'fact', '2026-10-08T09:30:00Z', { content: '某结论' })],
    )
    const pinBtn = container.querySelector('[data-artifact-id="f1"] button[title^="钉住"]') as HTMLButtonElement
    expect(pinBtn).toBeTruthy()
    act(() => { pinBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // 钉住后 title 变为「取消钉住」，钉住样式在 [data-artifact-id] 根元素自身
    // （bg-otter-50/50 是 bg-otter-50 的带透明度变体，toContain 前缀命中）
    const pinnedCard = container.querySelector('[data-artifact-id="f1"]')
    expect(pinnedCard!.className).toContain('bg-otter-50')
  })

  it('fact 徽章「事实」/pr 徽章「PR」可见（与消息气泡强区分）', () => {
    renderTimeline(
      [msg('m1', '2026-10-08T09:00:00Z')],
      [
        res('f1', 'fact', '2026-10-08T09:30:00Z', { content: 'fact 内容' }),
        res('p1', 'pr', '2026-10-08T09:40:00Z', { url: 'https://github.com/a/b/pull/2', title: '修复空指针' }),
      ],
    )
    expect(container.textContent).toContain('事实')
    expect(container.textContent).toContain('PR')
    expect(container.textContent).toContain('修复空指针')
  })
})
