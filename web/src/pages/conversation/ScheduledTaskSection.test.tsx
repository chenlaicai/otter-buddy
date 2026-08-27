// @vitest-environment jsdom
/**
 * ScheduledTaskSection restartBeforeInvoke 标签展示测试
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ScheduledTaskSection } from './ScheduledTaskSection'
import type { LocalScheduledTask } from '../../lib/mappers'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function makeTask(overrides: Partial<LocalScheduledTask> = {}): LocalScheduledTask {
  return {
    id: 't1',
    conversationId: 'c1',
    name: '测试任务',
    scheduleType: 'cron',
    cron: '0 9 * * *',
    triggerAt: null,
    timezone: 'Asia/Shanghai',
    body: '测试消息',
    talkingStonePassedTo: ['otter-1'],
    senderId: 'otter-1',
    status: 'active',
    consecutiveFailures: 0,
    lastTriggeredAt: null,
    restartBeforeInvoke: false,
    timeoutMinutes: null,
    nextTriggerAt: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  }
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

function renderSection(tasks: LocalScheduledTask[]) {
  act(() => {
    root.render(
      <ScheduledTaskSection
        tasks={tasks}
        onToggle={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onTrigger={() => {}}
        onViewHistory={() => {}}
      />
    )
  })
}

describe('ScheduledTaskSection restartBeforeInvoke 标签', () => {
  it('restartBeforeInvoke=true 时展示"重启獭生"标签', () => {
    renderSection([makeTask({ restartBeforeInvoke: true })])
    expect(container.textContent).toContain('重启獭生')
  })

  it('restartBeforeInvoke=false 时不展示标签', () => {
    renderSection([makeTask({ restartBeforeInvoke: false })])
    expect(container.textContent).not.toContain('重启獭生')
  })

  it('多个任务各自独立展示标签', () => {
    renderSection([
      makeTask({ id: 't1', name: '任务A', restartBeforeInvoke: true }),
      makeTask({ id: 't2', name: '任务B', restartBeforeInvoke: false }),
    ])
    const taskCards = container.querySelectorAll('.glass-card')
    // 任务A 应有标签
    expect(taskCards[0].textContent).toContain('重启獭生')
    // 任务B 不应有标签
    expect(taskCards[1].textContent).not.toContain('重启獭生')
  })
})
