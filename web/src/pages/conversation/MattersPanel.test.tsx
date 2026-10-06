// @vitest-environment jsdom
/**
 * F20261006mtlp P1：右侧栏「待办」tab 渲染测试。
 *
 * - tab 存在（ClipboardList 图标 + 「待办」标签，id=matters）
 * - 切换后渲染 MattersPanel（空态/列表/角标语义由面板数据驱动——
 *   jsdom 无后端，fetch 静默失败 → 空态渲染）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { RightPanel } from './RightPanel'
import type { LocalConversation as Conversation, LocalOtter as Otter, LocalLinkedResource as LinkedResource, LocalOtterSession as OtterSession, LocalScheduledTask } from '../../lib/mappers'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const noop = () => {}

function renderPanel() {
  const conversation = { id: 'c1', title: '测试对话', createdAt: '' } as unknown as Conversation
  act(() => {
    root.render(
      <RightPanel
        conversation={conversation}
        otters={[] as Otter[]}
        sessions={{} as Record<string, OtterSession[]>}
        linkedResources={[] as LinkedResource[]}
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
      />,
    )
  })
}

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

describe('RightPanel 待办 tab（F20261006mtlp P1）', () => {
  it('第五 tab「待办」存在（ClipboardList 图标 + 待办标签）', () => {
    renderPanel()
    const tab = container.querySelector('[data-testid="tab-matters"]')
    expect(tab).not.toBeNull()
    expect(tab!.textContent).toContain('待办')
  })

  it('切换到待办 tab 渲染面板（无后端时 fetch 静默失败 → 空态）', async () => {
    renderPanel()
    switchTab('matters')
    // 等一轮 effect（fetch 失败静默，最终渲染空态）
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(container.querySelector('[data-testid="matters-panel"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="matter-empty"]')).not.toBeNull()
    expect(container.textContent).toContain('待办板为空')
  })
})
