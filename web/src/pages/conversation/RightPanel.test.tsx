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


const noop = () => {}

function renderPanel(_resources: LinkedResource[], otters: Otter[] = [], extra: { sessions?: Record<string, OtterSession[]>; invokeStates?: import('../../lib/invoke-tracker').InvokeStates } = {}) {
  const conversation = { id: 'c1', title: '测试对话', createdAt: '' } as unknown as Conversation
  const sessions: Record<string, OtterSession[]> = extra.sessions ?? {}
  act(() => {
    root.render(
      <RightPanel
        conversation={conversation}
        otters={otters}
        sessions={sessions}
        invokeStates={extra.invokeStates}
        onCreateSmallOtter={noop}
        onDissolveOtter={noop}
        onRestartOtter={noop}
        onOpenOtterDetail={noop}
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

  it('点击切换 tab 应显示对应内容（F20261009csf3：resources tab 已退役，4 tab）', async () => {
    renderPanel([], [])
    // resources tab 按钮不应存在
    expect(container.querySelector('[data-testid="tab-resources"]')).toBeNull()

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

  it('第五 tab「待办」存在且切换渲染 MattersPanel（F20261006mtlp/mlp2；F20261009csf3 后为第四 tab）', async () => {
    renderPanel([], [])
    const mattersTab = container.querySelector('[data-testid="tab-matters"]')
    expect(mattersTab).not.toBeNull()
    expect(mattersTab!.textContent).toContain('待办')
    // mock fetch（useMatters 拉 open + 含 closed 两路，无后端时静默失败 → 空态）
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 })))
    switchTab('matters')
    await act(async () => { await new Promise<void>(r => setTimeout(r, 0)) })
    expect(container.querySelector('[data-testid="matters-panel"]')).not.toBeNull()
  })

  it('切换 tab 时应保持各 tab 的状态', () => {
    renderPanel([], [])
    switchTab('tasks')
    // tasks 面板特征：空态文案「暂无定时任务」只在 tasks 内容区出现（tab 条只有两字按钮文案）
    expect(container.textContent).toContain('暂无定时任务')
    switchTab('participants')
    expect(container.textContent).not.toContain('暂无定时任务')
    switchTab('tasks')
    expect(container.textContent).toContain('暂无定时任务')
  })
})

/* F20261009csf3：FactItem/LinkedResourceItem describe 块随关键资源 tab 退役移除 */

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

  it('isDefault=true 时 badge 追加「（默认）」标注（F20260908efmd 有效模型）', () => {
    renderPanel([], [makeOtter({ modelAlias: 'kimi', modelIsDefault: true })])
    const badge = container.querySelector('[data-testid="model-badge"]')
    expect(badge!.textContent).toBe('kimi（默认）')
  })

  it('isDefault=false/缺省时 badge 不带默认标注', () => {
    renderPanel([], [makeOtter({ modelAlias: 'kimi', modelIsDefault: false })])
    const badge = container.querySelector('[data-testid="model-badge"]')
    expect(badge!.textContent).toBe('kimi')
  })

  it('大獭卡不再渲染冗余「大獭」badge；副行「大獭 · 持久」前缀已移除（F20260914rtsp 搭档拍板：大獭必然在场不需重申）', () => {
    renderPanel([], [makeOtter({ id: 'big-1', name: '大獭', type: 'big', modelAlias: 'glm' })])
    // 名字仍在
    expect(container.textContent).toContain('大獭')
    // F20260914rtsp：「大獭 · 持久」前缀移除（副行只余世数时间，无 session 时为空）
    expect(container.textContent).not.toContain('持久')
    // 身份 badge（rounded-full 且文本恰为「大獭」）不存在
    const texts = Array.from(container.querySelectorAll('span.rounded-full')).map(el => el.textContent)
    expect(texts).not.toContain('大獭')
    expect(container.querySelector('[data-testid="model-badge"]')!.textContent).toBe('glm')
  })

  it('副行时间戳 truncate：完整时间字符串不再撑高卡片（#757；F20260914rtsp 改「第N世 from 时间」格式）', () => {
    renderPanel([], [makeOtter({ id: 'big-3', name: '大獭', type: 'big', modelAlias: 'glm-flash' })])
    // 副行有 nowrap+truncate 防护（sessions 为空 → 时间行不渲染，只断言副行存在且防护 class 在源码同批应用）
    const sub = Array.from(container.querySelectorAll('div')).find(el => el.textContent?.includes('大獭') === false && el.className.includes('truncate') && el.className.includes('whitespace-nowrap'))
    // 无 session 时副行为空字符串——但仍渲染且带防护 class
    expect(sub).toBeDefined()
  })

  it('长 modelAlias（glm-flash 等）badge 不换行不压缩（whitespace-nowrap + shrink-0 防卡片竖向变形）', () => {
    renderPanel([], [makeOtter({ id: 'big-2', name: '大獭', type: 'big', modelAlias: 'glm-flash' })])
    const badge = container.querySelector('[data-testid="model-badge"]') as HTMLElement
    expect(badge).not.toBeNull()
    expect(badge.className).toContain('whitespace-nowrap')
    expect(badge.className).toContain('shrink-0')
  })
})

describe('OtterParticipantCard invoke 状态行（F20260916rcxa：休息中恒显示上下文使用量）', () => {
  function makeOtter(overrides: Partial<Otter> = {}): Otter {
    return {
      id: 'o1', name: '小獭', type: 'small', createdAt: '2026-08-25',
      ...overrides,
    } as Otter
  }

  function activeSession(otterId: string): OtterSession {
    return {
      id: 's1', otterId, status: 'active', previousSessionId: null,
      startedAt: '2026-09-16T08:00:00Z', archivedAt: null, archiveReason: null,
      isNegativeCase: false, summary: null,
    } as OtterSession
  }

  it('有 activeS 无 invokeState（从未行动但有世）→ 渲染休息中行「○ 休息中 · —/—」', () => {
    const o = makeOtter()
    renderPanel([], [o], { sessions: { o1: [activeSession('o1')] } })
    const line = container.querySelector('[data-testid="invoke-state-line"]')
    expect(line).not.toBeNull()
    expect(line!.textContent).toContain('休息中')
    expect(line!.textContent).toContain('—')
  })

  it('有 activeS 有 invokeState（终态带 ctx）→ 渲染休息中行并展示真实 ctx 值', () => {
    const o = makeOtter()
    renderPanel([], [o], {
      sessions: { o1: [activeSession('o1')] },
      invokeStates: {
        o1: {
          invokeId: 'inv-1', otterId: 'o1', status: 'completed',
          startedAt: '2026-09-16T08:00:00Z', endedAt: '2026-09-16T08:01:00Z',
          ctxWindowUsed: 45200, ctxMax: 200000,
        },
      },
    })
    const line = container.querySelector('[data-testid="invoke-state-line"]')
    expect(line).not.toBeNull()
    expect(line!.textContent).toContain('休息中')
    expect(line!.textContent).toContain('45.2k')
    expect(line!.textContent).toContain('200.0k')
  })

  it('有 invokeState（running）→ 渲染行动中行', () => {
    const o = makeOtter()
    renderPanel([], [o], {
      sessions: { o1: [activeSession('o1')] },
      invokeStates: {
        o1: {
          invokeId: 'inv-2', otterId: 'o1', status: 'running',
          startedAt: new Date(Date.now() - 5000).toISOString(),
          ctxWindowUsed: 45200, ctxMax: 200000, toolCallCount: 3,
        },
      },
    })
    const line = container.querySelector('[data-testid="invoke-state-line"]')
    expect(line).not.toBeNull()
    expect(line!.textContent).toContain('行动中')
  })

  it('无 activeS 无 invokeState（从未搼过的新獭）→ 不渲染状态行', () => {
    renderPanel([], [makeOtter()])
    expect(container.querySelector('[data-testid="invoke-state-line"]')).toBeNull()
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

/* F20261009csf3：ResourceHoverCard describe 块随关键资源 tab 退役移除（悬浮卡只服务资源条目） */
