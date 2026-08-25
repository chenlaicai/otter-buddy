// @vitest-environment jsdom
/**
 * ScheduledTaskModal restartBeforeInvoke toggle 测试
 *
 * F20260825scrf 适配：Modal 改 createPortal 后内容渲染到 document.body，
 * 查询范围从 container 改为 document（container 里只剩挂载占位）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ScheduledTaskModal } from './ScheduledTaskModal'
import type { LocalOtter } from '../../lib/mappers'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const mockOtters: LocalOtter[] = [
  { id: 'otter-1', name: '大獭', type: 'big', createdAt: '2025-01-01' },
]

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  // F20260825scrf 检视 A-2：Modal Portal 后内容挂 document.body，清理残留防串测
  document.body.innerHTML = ''
})

function renderModal(
  onSave: (data: {
    name: string; cron: string; timezone: string; body: string;
    talkingStonePassedTo: string[]; restartBeforeInvoke: boolean
  }) => void = () => {},
  overrides: Record<string, unknown> = {},
) {
  act(() => {
    root.render(
      <ScheduledTaskModal
        mode={(overrides.mode as 'create' | 'edit') ?? 'create'}
        otters={mockOtters}
        onSave={onSave}
        onClose={() => {}}
        {...(overrides.task ? { task: overrides.task as never } : {})}
      />
    )
  })
}

function findToggle(): HTMLButtonElement {
  // restartBeforeInvoke toggle 是表单区域内最后一个没有 type="button" 的按钮，
  // 但实际有 type="button"。通过文本定位。
  const buttons = document.querySelectorAll('button[type="button"]')
  for (const btn of buttons) {
    if (btn.textContent === '' && btn.className.includes('rounded-full') && btn.closest('.bg-stone-50\\/50')) {
      return btn as HTMLButtonElement
    }
  }
  // fallback: 在 "每次触发前重启獭生" 文本附近的 button
  const label = Array.from(document.querySelectorAll('div')).find(d => d.textContent?.includes('每次触发前重启獭生'))
  if (label) {
    const parent = label.closest('.flex.items-center.justify-between')
    if (parent) {
      const btn = parent.querySelector('button')
      if (btn) return btn as HTMLButtonElement
    }
  }
  throw new Error('restartBeforeInvoke toggle not found')
}

function fillRequiredFields() {
  const nameInput = document.querySelector('input[type="text"]') as HTMLInputElement
  act(() => {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    nativeInputValueSetter.call(nameInput, '测试任务')
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    nameInput.dispatchEvent(new Event('change', { bubbles: true }))
  })

  const textarea = document.querySelector('textarea') as HTMLTextAreaElement
  act(() => {
    const nativeTextareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    nativeTextareaSetter.call(textarea, '测试消息内容')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('ScheduledTaskModal restartBeforeInvoke toggle', () => {
  it('toggle 默认为关闭状态', () => {
    renderModal()
    const toggle = findToggle()
    expect(toggle.className).toContain('bg-stone-300')
    expect(toggle.className).not.toContain('bg-otter-500')
  })

  it('点击 toggle 切换为开启状态', () => {
    renderModal()
    const toggle = findToggle()
    act(() => { toggle.click() })
    expect(toggle.className).toContain('bg-otter-500')
    expect(toggle.className).not.toContain('bg-stone-300')
  })

  it('onSave 默认携带 restartBeforeInvoke=false', async () => {
    const onSave = vi.fn()
    renderModal(onSave)
    fillRequiredFields()
    const submitBtn = Array.from(document.querySelectorAll('button')).find(
      b => b.textContent?.includes('创建')
    )!
    await act(async () => { submitBtn.click() })
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ restartBeforeInvoke: false })
    )
  })

  it('开启 toggle 后 onSave 携带 restartBeforeInvoke=true', async () => {
    const onSave = vi.fn()
    renderModal(onSave)
    fillRequiredFields()
    const toggle = findToggle()
    act(() => { toggle.click() })
    const submitBtn = Array.from(document.querySelectorAll('button')).find(
      b => b.textContent?.includes('创建')
    )!
    await act(async () => { submitBtn.click() })
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ restartBeforeInvoke: true })
    )
  })

  it('编辑模式下 restartBeforeInvoke=true 时 toggle 初始为开启', () => {
    renderModal(() => {}, {
      mode: 'edit',
      task: {
        id: 't1', conversationId: 'c1', name: '已有任务', scheduleType: 'cron',
        cron: '0 9 * * *', triggerAt: null, timezone: 'Asia/Shanghai', body: 'body',
        talkingStonePassedTo: ['otter-1'], senderId: 'otter-1', status: 'active',
        consecutiveFailures: 0, lastTriggeredAt: null, restartBeforeInvoke: true,
        nextTriggerAt: null, createdAt: '', updatedAt: '',
      },
    })
    const toggle = findToggle()
    expect(toggle.className).toContain('bg-otter-500')
  })

  it('编辑模式下 restartBeforeInvoke=false 时 toggle 初始为关闭', () => {
    renderModal(() => {}, {
      mode: 'edit',
      task: {
        id: 't1', conversationId: 'c1', name: '已有任务', scheduleType: 'cron',
        cron: '0 9 * * *', triggerAt: null, timezone: 'Asia/Shanghai', body: 'body',
        talkingStonePassedTo: ['otter-1'], senderId: 'otter-1', status: 'active',
        consecutiveFailures: 0, lastTriggeredAt: null, restartBeforeInvoke: false,
        nextTriggerAt: null, createdAt: '', updatedAt: '',
      },
    })
    const toggle = findToggle()
    expect(toggle.className).toContain('bg-stone-300')
    expect(toggle.className).not.toContain('bg-otter-500')
  })
})
