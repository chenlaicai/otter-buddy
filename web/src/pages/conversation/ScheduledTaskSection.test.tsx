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
    description: null,
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

describe('ScheduledTaskSection resolveTaskPreview 描述优先级（F20260915desc 发现 2 补测）', () => {
  it('description 非空时优先显示 description（忽略 body）', () => {
    renderSection([makeTask({
      description: '每个交易日撮合昨日挂单',
      body: '{"prompt":"不应被显示"}',
    })])
    expect(container.textContent).toContain('每个交易日撮合昨日挂单')
    expect(container.textContent).not.toContain('不应被显示')
  })

  it('description=null 且 body 为 JSON 包装时提取 prompt 字段', () => {
    renderSection([makeTask({
      description: null,
      body: JSON.stringify({ prompt: '# 操盘獭每日任务\n\n你是纸面交易系统的操盘獭', watchlist: ['600519'] }),
    })])
    expect(container.textContent).toContain('操盘獭每日任务')
  })

  it('description=null 且 body 为纯文本（非 JSON）时直接预览原文', () => {
    renderSection([makeTask({
      description: null,
      body: '请生成今日对话总结',
    })])
    expect(container.textContent).toContain('请生成今日对话总结')
  })

  it('description=null 且 body=\'{}\'（典型 function 型）时显示「未填写任务描述」兜底', () => {
    renderSection([makeTask({
      description: null,
      body: '{}',
    })])
    expect(container.textContent).toContain('未填写任务描述')
  })

  it('description=null 且 body=空串 时同样显示「未填写任务描述」兜底', () => {
    renderSection([makeTask({
      description: null,
      body: '',
    })])
    expect(container.textContent).toContain('未填写任务描述')
  })

  it('description=null 且 body 为 JSON 但无 prompt 字段时回退预览原文', () => {
    renderSection([makeTask({
      description: null,
      body: JSON.stringify({ foo: 'bar' }),
    })])
    // 应回退预览原始 JSON 文本（不是「未填写」也不是 prompt）
    expect(container.textContent).toContain('foo')
    expect(container.textContent).not.toContain('未填写任务描述')
  })

  it('description=空串时与 null 同语义（走 body 回退）', () => {
    renderSection([makeTask({
      description: '',
      body: '请生成今日对话总结',
    })])
    expect(container.textContent).toContain('请生成今日对话总结')
  })

  it('description=纯空白时与 null 同语义（trim 后为空走 body 回退）', () => {
    renderSection([makeTask({
      description: '   ',
      body: '请生成今日对话总结',
    })])
    expect(container.textContent).toContain('请生成今日对话总结')
  })
})
