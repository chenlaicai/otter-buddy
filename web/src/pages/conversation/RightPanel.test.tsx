// @vitest-environment jsdom
/**
 * RightPanel 关键资源展示测试（F20260825krui；F20260827rsux 升级 hover 卡行为）
 * - FactItem：长内容截断（truncate）+ 悬浮详情卡显示全文（可复制）
 * - LinkedResourceItem：统一 stone 色系 + 类型色块 + 截断 + 悬浮详情卡
 * - F20260828tab：tab 切换逻辑
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { fireEvent } from '@testing-library/react'
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

const noop = () => {}

function renderPanel(resources: LinkedResource[], otters: Otter[] = []) {
  const conversation = { id: 'c1', title: '测试对话', createdAt: '' } as unknown as Conversation
  const sessions: Record<string, OtterSession[]> = {}
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

/** 切换到指定 tab（通过 data-testid 定位） */
function switchTab(tabId: string) {
  const btn = container.querySelector(`[data-testid="tab-${tabId}"]`) as HTMLButtonElement
  expect(btn).not.toBeNull()
  act(() => { fireEvent.click(btn) })
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

describe('RightPanel tab 切换', () => {
  it('默认激活参与者 tab', () => {
    renderPanel([], [])
    // 参与者 tab 按钮存在且内容区显示参与者
    const participantTab = container.querySelector('[data-testid="tab-participants"]')
    expect(participantTab).not.toBeNull()
    expect(container.textContent).toContain('Otter 参与者')
  })

  it('点击切换 tab 应显示对应内容', async () => {
    renderPanel([], [])
    switchTab('resources')
    expect(container.textContent).toContain('暂无关键资源')

    switchTab('tasks')
    expect(container.textContent).toContain('定时任务')

    // A5: mock fetch BEFORE switching to workspace tab (WorkspacePanel useEffect fires on mount)
    const workspaceEntries = {
      entries: [{ name: 'file.txt', isDirectory: false, isFile: true, path: 'file.txt' }]
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(workspaceEntries), { status: 200 })
    ))
    switchTab('workspace')
    // flush microtasks (fetch in useEffect resolves → state update → re-render)
    await act(async () => { await new Promise<void>(r => setTimeout(r, 0)) })
    const tree = container.querySelector('[data-testid="workspace-tree"]')
    expect(tree).not.toBeNull()
  })

  it('切换 tab 时应保持各 tab 的状态', () => {
    const resources = [makeResource({ type: 'fact', content: '测试事实' })]
    renderPanel(resources, [])

    switchTab('resources')
    expect(container.textContent).toContain('测试事实')

    switchTab('tasks')
    expect(container.textContent).not.toContain('测试事实')

    switchTab('resources')
    expect(container.textContent).toContain('测试事实')
  })
})

describe('FactItem', () => {
  it('长内容应截断，悬浮详情卡展示全文（F20260827rsux）', () => {
    const longContent = '这是一条非常长的事实内容'.repeat(10)
    renderPanel([makeResource({ type: 'fact', content: longContent })])
    // 事实内容在 resources tab 下，需要先切换
    switchTab('resources')
    const truncated = container.querySelector('.truncate')
    expect(truncated).not.toBeNull()
    expect(truncated!.textContent).toBe(longContent)
    // 默认不弹 hover 卡；title 原生 tooltip 已移除
    expect(truncated!.getAttribute('title')).toBeNull()
    expect(document.querySelector('.glass-strong')).toBeNull()
  })

  it('分类徽章与内容分行展示', () => {
    renderPanel([makeResource({ type: 'fact', content: '短事实', category: '决策' })])
    switchTab('resources')
    const badges = Array.from(container.querySelectorAll('.rounded-full')).filter(el => el.textContent === '决策')
    expect(badges.length).toBe(1)
  })
})

describe('LinkedResourceItem', () => {
  it('链接资源应有类型色块且不再使用 teal 正文色', () => {
    renderPanel([makeResource({ type: 'pr', url: 'https://github.com/x/y/pull/1', title: 'PR: 修复登录' })])
    switchTab('resources')
    const badge = Array.from(container.querySelectorAll('span')).find(el => el.textContent === 'pr')
    expect(badge).not.toBeUndefined()
    // 正文统一 stone 色系（不再 teal-500 正文）
    const tealText = Array.from(container.querySelectorAll('span')).find(el =>
      el.className.includes('text-teal-500') && el.textContent === 'PR: 修复登录'
    )
    expect(tealText).toBeUndefined()
  })

  it('长标题截断，悬浮详情卡展示 url（F20260827rsux）', () => {
    const longTitle = '超长资源标题'.repeat(20)
    const url = 'https://example.com/very/long/path'
    renderPanel([makeResource({ type: 'url', url, title: longTitle })])
    switchTab('resources')
    const truncated = container.querySelector('.truncate')
    expect(truncated).not.toBeNull()
    expect(truncated!.getAttribute('title')).toBeNull()
    expect(truncated!.textContent).toBe(longTitle)
    expect(document.querySelector('.glass-strong')).toBeNull()
  })

  it('无 title 时显示 url，无 url 时显示占位符', () => {
    renderPanel([makeResource({ type: 'file', url: null, title: '' })])
    switchTab('resources')
    const placeholder = Array.from(container.querySelectorAll('.truncate')).find(el => el.textContent === '(无标题)')
    expect(placeholder).not.toBeUndefined()
  })

  it('有 title 无 url 时详情卡仍展示 title 全文（截断场景下悬停仍有增量）', () => {
    const longTitle = '很长的资源标题无需 url 也能看全文'.repeat(8)
    renderPanel([makeResource({ type: 'file', url: null, title: longTitle })])
    switchTab('resources')
    const truncated = container.querySelector('.truncate')
    expect(truncated).not.toBeNull()
    expect(truncated!.getAttribute('title')).toBeNull()
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

  it('大獭卡不再渲染冗余「大獭」badge（名字行已固定显示名字，副行有「大獭 · 持久」），但模型 badge 正常展示', () => {
    renderPanel([], [makeOtter({ id: 'big-1', name: '大獭', type: 'big', modelAlias: 'glm' })])
    // 名字与副行身份信息仍在
    expect(container.textContent).toContain('大獭')
    expect(container.textContent).toContain('大獭 · 持久')
    // 身份 badge（rounded-full 且文本恰为「大獭」）不存在
    const texts = Array.from(container.querySelectorAll('span.rounded-full')).map(el => el.textContent)
    expect(texts).not.toContain('大獭')
    expect(container.querySelector('[data-testid="model-badge"]')!.textContent).toBe('glm')
  })

  it('长 modelAlias（glm-flash 等）badge 不换行不压缩（whitespace-nowrap + shrink-0 防卡片竖向变形）', () => {
    renderPanel([], [makeOtter({ id: 'big-2', name: '大獭', type: 'big', modelAlias: 'glm-flash' })])
    const badge = container.querySelector('[data-testid="model-badge"]') as HTMLElement
    expect(badge).not.toBeNull()
    expect(badge.className).toContain('whitespace-nowrap')
    expect(badge.className).toContain('shrink-0')
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

/** F20260827rsux：资源悬浮详情卡（hover 400ms debounce + 全文展示 + 复制按钮）。
 *  断言策略：hover 卡经 createPortal 挂 document.body，断言 body 内出现 .glass-strong
 *  且含资源全文与「复制全文」按钮（fact 与链接类各一例 + 快速滑过不弹）。 */
describe('ResourceHoverCard（F20260827rsux）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function factRow() {
    return Array.from(container.querySelectorAll('.group'))
      .find(el => el.textContent?.includes('事实A')) as HTMLElement
  }

  it('fact 条目停留 ≥400ms 弹出悬浮卡，含全文与复制按钮', () => {
    renderPanel([makeResource({ type: 'fact', content: '事实A的完整内容', category: '决策' })])
    switchTab('resources')
    act(() => { fireEvent.mouseEnter(factRow()) })
    expect(document.querySelector('.glass-strong')).toBeNull()
    act(() => { vi.advanceTimersByTime(400) })
    const card = document.querySelector('.glass-strong')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('事实A的完整内容')
    expect(card!.textContent).toContain('决策')
    expect(card!.querySelector('button')!.getAttribute('title')).toBe('复制全文')
    act(() => { fireEvent.mouseLeave(factRow()) })
    expect(document.querySelector('.glass-strong')).toBeNull()
  })

  it('链接资源悬浮卡展示标题与 url', () => {
    renderPanel([makeResource({ type: 'pr', url: 'https://github.com/x/y/pull/9', title: 'PR 九号' })])
    switchTab('resources')
    const row = Array.from(container.querySelectorAll('.group'))
      .find(el => el.textContent?.includes('PR 九号')) as HTMLElement
    act(() => { fireEvent.mouseEnter(row) })
    act(() => { vi.advanceTimersByTime(400) })
    const card = document.querySelector('.glass-strong')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('PR 九号')
    expect(card!.textContent).toContain('https://github.com/x/y/pull/9')
  })

  it('快速滑过（<400ms 移出）不弹出悬浮卡', () => {
    renderPanel([makeResource({ type: 'fact', content: '事实A', category: null })])
    switchTab('resources')
    act(() => { fireEvent.mouseEnter(factRow()) })
    act(() => { vi.advanceTimersByTime(150) })
    act(() => { fireEvent.mouseLeave(factRow()) })
    act(() => { vi.advanceTimersByTime(500) })
    expect(document.querySelector('.glass-strong')).toBeNull()
  })

  /** 检视发现 2：复制内容不含 category 徽章文本——copyText 声明式传入，
   *  fact 类只复制正文；徽章仅作展示元数据。 */
  it('点击复制按钮：writeText 收到 fact 正文（不含分类徽章），成功后 ✓', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      renderPanel([makeResource({ type: 'fact', content: '事实A的完整内容', category: '决策' })])
      switchTab('resources')
      act(() => { fireEvent.mouseEnter(factRow()) })
      act(() => { vi.advanceTimersByTime(400) })
      const card = document.querySelector('.glass-strong')!
      const copyBtn = card.querySelector('button[title="复制全文"]')! as HTMLButtonElement
      await act(async () => { fireEvent.click(copyBtn) })
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(writeText).toHaveBeenCalledWith('事实A的完整内容')
      // ✓ 态：icon 切换，1.5s 后回落
      expect(card.querySelector('.text-teal-500')).not.toBeNull()
      act(() => { vi.advanceTimersByTime(1600) })
      expect(card.querySelector('.text-teal-500')).toBeNull()
    } finally {
      // @ts-expect-error 测试注入的 clipboard 需清理，避免泄漏到其他用例
      delete navigator.clipboard
    }
  })

  it('链接类复制：writeText 收到「标题\nurl」两行', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      renderPanel([makeResource({ type: 'pr', url: 'https://github.com/x/y/pull/9', title: 'PR 九号' })])
      switchTab('resources')
      const row = Array.from(container.querySelectorAll('.group'))
        .find(el => el.textContent?.includes('PR 九号')) as HTMLElement
      act(() => { fireEvent.mouseEnter(row) })
      act(() => { vi.advanceTimersByTime(400) })
      const copyBtn = document.querySelector('.glass-strong button[title="复制全文"]')! as HTMLButtonElement
      await act(async () => { fireEvent.click(copyBtn) })
      expect(writeText).toHaveBeenCalledWith('PR 九号\nhttps://github.com/x/y/pull/9')
    } finally {
      // @ts-expect-error 测试注入的 clipboard 需清理，避免泄漏到其他用例
      delete navigator.clipboard
    }
  })

  /** 检视发现 3：hover 计时器 pending 时 unmount，effect 清理路径不炸、不弹出 */
  it('hover 计时器 pending 时卸载组件，不报错且不弹出悬浮卡', () => {
    renderPanel([makeResource({ type: 'fact', content: '事实A', category: null })])
    switchTab('resources')
    act(() => { fireEvent.mouseEnter(factRow()) })
    act(() => { vi.advanceTimersByTime(150) }) // timer 仍 pending
    expect(() => {
      act(() => { root.unmount() })
    }).not.toThrow()
    act(() => { vi.advanceTimersByTime(500) })
    expect(document.querySelector('.glass-strong')).toBeNull()
  })
})
