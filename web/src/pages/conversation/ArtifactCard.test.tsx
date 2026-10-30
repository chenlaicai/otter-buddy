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
    category: null, flagged: false, auto: true, createdAt,
    status: 'active', ...extra,
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
      ? el.getAttribute('data-message-id') ?? '?'
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

  it('与首消息同刻登记 → 插最前（同刻并列资源在前；早于窗口全部消息的产物被窗口下界过滤，见分页窗口用例）', () => {
    renderTimeline(
      [msg('m1', '2026-10-08T09:00:00Z')],
      [res('p1', 'pr', '2026-10-08T09:00:00Z')],
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

  it('superseded/archived 产物不混排（只认 active，检视发现 4）', () => {
    renderTimeline(
      [msg('m1', '2026-10-08T09:00:00Z')],
      [res('s1', 'pr', '2026-10-08T09:30:00Z', { status: 'superseded' }), res('a1', 'file', '2026-10-08T09:40:00Z', { status: 'archived' })],
    )
    expect(timelineOrder()).toEqual(['m1'])
  })

  it('早于窗口最早消息的产物不显示（分页窗口下界，检视发现 2）', () => {
    // 模拟分页：首拉最新 2 条（m2/m3），全量产物里 r-old 诞生于 m1 之前（窗口外）
    renderTimeline(
      [msg('m2', '2026-10-08T10:00:00Z'), msg('m3', '2026-10-08T11:00:00Z')],
      [res('r-old', 'fact', '2026-10-08T08:00:00Z'), res('r-in', 'fact', '2026-10-08T10:30:00Z')],
    )
    // r-old 不聚集在窗口顶部冒充「最早」，窗口内诞生的 r-in 照常插入
    expect(timelineOrder()).toEqual(['m2', 'r-in', 'm3'])
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

  it('#1463 PR 状态徽章：OPEN×isDraft=true 显「草稿」（琥珀）；isDraft=false 显「开放中」（检视 r1 建议 5-2）', () => {
    renderTimeline(
      [msg('m1', '2026-10-08T09:00:00Z')],
      [
        res('pd', 'pr', '2026-10-08T09:30:00Z', {
          url: 'https://github.com/a/b/pull/9', title: 'draft PR',
          unfurl: { source: 'github-api', title: null, description: null, error: null, state: 'OPEN', isDraft: true, additions: 1, deletions: 1 },
        }),
        res('pr', 'pr', '2026-10-08T09:40:00Z', {
          url: 'https://github.com/a/b/pull/10', title: 'ready PR',
          unfurl: { source: 'github-api', title: null, description: null, error: null, state: 'OPEN', isDraft: false, additions: 1, deletions: 1 },
        }),
      ],
    )
    const draftCard = container.querySelector('[data-artifact-id="pd"]')
    const readyCard = container.querySelector('[data-artifact-id="pr"]')
    expect(draftCard?.textContent).toContain('草稿')
    expect(draftCard?.querySelector('.bg-amber-400\\/20')).not.toBeNull()
    expect(readyCard?.textContent).toContain('开放中')
    expect(readyCard?.textContent).not.toContain('草稿')
    expect(readyCard?.querySelector('.bg-teal-400\\/20')).not.toBeNull()
  })

  it('#1463 交叉态：CLOSED×isDraft=true 显「已关闭」而非「草稿」（检视 r1 建议 4 契约）', () => {
    renderTimeline(
      [msg('m1', '2026-10-08T09:00:00Z')],
      [
        res('pc', 'pr', '2026-10-08T09:30:00Z', {
          url: 'https://github.com/a/b/pull/11', title: 'closed draft PR',
          unfurl: { source: 'github-api', title: null, description: null, error: null, state: 'CLOSED', isDraft: true, additions: 1, deletions: 1 },
        }),
      ],
    )
    const card = container.querySelector('[data-artifact-id="pc"]')
    expect(card?.textContent).toContain('已关闭')
    expect(card?.textContent).not.toContain('草稿')
    expect(card?.querySelector('.bg-amber-400\\/20')).toBeNull()
    expect(card?.querySelector('.bg-stone-300\\/40')).not.toBeNull()
  })

  it('game 卡进入时间轴并可展开玩（F20261021gmbe 实景回归）', () => {
    renderTimeline(
      [msg('m1', '2026-10-08T09:00:00Z')],
      [res('g1', 'game', '2026-10-08T09:30:00Z', { url: '/mahjong/test-room', title: '大獭的麻将桌' })],
    )
    expect(timelineOrder()).toEqual(['m1', 'g1'])
    expect(container.textContent).toContain('大獭的麻将桌')
    expect(container.querySelector('[data-testid="game-expand"]')).not.toBeNull()
  })
})
