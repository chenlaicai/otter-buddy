// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { OtterProfileCard } from './OtterProfileCard'
import type { LocalOtter, LocalOtterSession } from '../lib/mappers'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

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
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(<OtterProfileCard otter={makeOtter()} sessions={[makeSession()]} />)
    })

    expect(container.textContent).toContain('测试獭')
    expect(container.textContent).toContain('任务专员')
    expect(container.textContent).toContain('Lv.1')

    act(() => { root.unmount() })
    container.remove()
  })

  it('大獭应显示"族群长老"称号', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(<OtterProfileCard otter={makeOtter({ type: 'big' })} sessions={[]} />)
    })

    expect(container.textContent).toContain('族群长老')

    act(() => { root.unmount() })
    container.remove()
  })

  it('有 modelAlias 时应显示武器', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(<OtterProfileCard otter={makeOtter()} sessions={[]} modelAlias="mimo" />)
    })

    expect(container.textContent).toContain('mimo')

    act(() => { root.unmount() })
    container.remove()
  })

  it('无 modelAlias 时不应显示武器行', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(<OtterProfileCard otter={makeOtter()} sessions={[]} />)
    })

    expect(container.textContent).not.toContain('mimo')

    act(() => { root.unmount() })
    container.remove()
  })
})
