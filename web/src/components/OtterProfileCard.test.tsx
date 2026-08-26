// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, fireEvent, cleanup } from '@testing-library/react'
import { OtterProfileCard } from './OtterProfileCard'
import type { LocalOtter, LocalOtterSession } from '../lib/mappers'

function makeOtter(overrides: Partial<LocalOtter> = {}): LocalOtter {
  return {
    id: 'o-test',
    name: '测试獭',
    type: 'small',
    createdAt: '2026-08-25',
    ...overrides,
  }
}

function makeSession(overrides: Partial<LocalOtterSession> = {}): LocalOtterSession {
  return {
    id: 's1',
    otterId: 'o-test',
    status: 'active',
    previousSessionId: null,
    startedAt: '2026-08-25 10:00',
    archivedAt: null,
    archiveReason: null,
    isNegativeCase: false,
    summary: null,
    ...overrides,
  }
}

describe('OtterProfileCard', () => {
  it('应显示獭名称和类型', () => {
    const { container } = render(
      <OtterProfileCard otter={makeOtter()} sessions={[makeSession()]} />
    )
    expect(container.textContent).toContain('测试獭')
    expect(container.textContent).toContain('任务专员')
    expect(container.textContent).toContain('Lv.1')
  })

  it('大獭应显示"族群长老"称号', () => {
    const { container } = render(
      <OtterProfileCard otter={makeOtter({ type: 'big' })} sessions={[]} />
    )
    expect(container.textContent).toContain('族群长老')
  })

  it('有 modelAlias 时应显示武器', () => {
    const { container } = render(
      <OtterProfileCard otter={makeOtter()} sessions={[]} modelAlias="mimo" />
    )
    expect(container.textContent).toContain('mimo')
  })

  it('无 modelAlias 时不应显示武器行', () => {
    const { container } = render(
      <OtterProfileCard otter={makeOtter()} sessions={[]} />
    )
    expect(container.textContent).not.toContain('mimo')
  })
})

/** PR-3：hover 400ms debounce 时序测试（组件级，@testing-library/react）。
 *
 *  渲染 OtterParticipantCard（RightPanel.tsx）验证真实 debounce 行为：
 *  - mouseenter → setTimeout(400ms) → setHovering(true) → OtterProfileCard 渲染
 *  - mouseleave → clearTimeout + setHovering(false) → 卡片消失
 *
 *  断言策略：用 OtterProfileCard 独有的 "Lv." 文本判定快览卡是否渲染。
 *  OtterParticipantCard 不含此文本。 */
describe('hover 400ms debounce 时序（PR-3）', () => {
  // Why: isTouchDevice() 缓存 matchMedia 结果；
  // jsdom 无 matchMedia → falsy → 非触屏，hover 监听正常注册
  let RightPanel: typeof import('../pages/conversation/RightPanel').RightPanel

  beforeEach(async () => {
    vi.useFakeTimers()
    const mod = await import('../pages/conversation/RightPanel')
    RightPanel = mod.RightPanel
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  function renderPanel() {
    return render(
      <RightPanel
        otters={[makeOtter()]}
        sessions={{ 'o-test': [makeSession()] }}
        linkedResources={[]}
        scheduledTasks={[]}
        scheduledTasksLoading={false}
        onCreateSmallOtter={() => {}}
        onDissolveOtter={() => {}}
        onRestartOtter={() => {}}
        onOpenOtterDetail={() => {}}
        onAddFact={() => {}}
        onToggleResourceFlag={() => {}}
        onAddLinkedResource={() => {}}
        onDeleteLinkedResource={() => {}}
        onToggleScheduledTask={() => {}}
        onCreateScheduledTask={() => {}}
        onEditScheduledTask={() => {}}
        onDeleteScheduledTask={() => {}}
        onTriggerScheduledTask={() => {}}
        onViewScheduledTaskHistory={() => {}}
      />
    )
  }

  it('停留 ≥400ms 弹出快览卡', async () => {
    const { container } = renderPanel()
    const card = container.querySelector('.relative')!

    // 触发 hover
    await act(async () => {
      fireEvent.mouseEnter(card)
    })

    // ≥400ms：快览卡应出现
    act(() => { vi.advanceTimersByTime(400) })
    expect(container.textContent).toContain('Lv.')
  })

  it('快速滑过（<400ms 移出）不弹出快览卡', async () => {
    const { container } = renderPanel()
    const card = container.querySelector('.relative')!

    // 进入
    await act(async () => {
      fireEvent.mouseEnter(card)
    })

    // <400ms 移出
    act(() => { vi.advanceTimersByTime(399) })
    await act(async () => {
      fireEvent.mouseLeave(card)
    })

    // 快览卡不应出现
    expect(container.textContent).not.toContain('Lv.')

    // 推进到 400ms+，确认仍未出现
    act(() => { vi.advanceTimersByTime(200) })
    expect(container.textContent).not.toContain('Lv.')
  })

  it('移出后重新进入需重新计时', async () => {
    const { container } = renderPanel()
    const card = container.querySelector('.relative')!

    // 进入 → 200ms → 移出
    await act(async () => {
      fireEvent.mouseEnter(card)
    })
    act(() => { vi.advanceTimersByTime(200) })
    await act(async () => {
      fireEvent.mouseLeave(card)
    })

    // 再次进入 → 200ms → 不应出现（重新计时）
    await act(async () => {
      fireEvent.mouseEnter(card)
    })
    act(() => { vi.advanceTimersByTime(200) })
    expect(container.textContent).not.toContain('Lv.')

    // 再等 200ms（第二次进入后 400ms）→ 应出现
    act(() => { vi.advanceTimersByTime(200) })
    expect(container.textContent).toContain('Lv.')
  })
})
