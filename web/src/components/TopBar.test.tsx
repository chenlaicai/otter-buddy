// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TopBar } from './TopBar'
import { NAV_ROUTES } from '@contract/web/pages'

describe('TopBar 悬浮主导航', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('左侧仅保留系统图标，中央菜单使用独立玻璃容器', () => {
    const { container } = render(<MemoryRouter><TopBar /></MemoryRouter>)

    expect(screen.getByRole('img', { name: 'Otter Buddy' })).toBeTruthy()
    expect(screen.queryByText('Otter Buddy')).toBeNull()
    expect(container.querySelector('header')?.classList.contains('glass-strong')).toBe(false)
    expect(screen.getByRole('navigation', { name: '主导航' }).classList.contains('glass-nav')).toBe(true)
    expect(container.querySelector('.glass-nav-effect .glass-nav-sample')).not.toBeNull()
    expect(container.querySelector('feDisplacementMap')?.getAttribute('scale')).toBe('80')
    expect(screen.getAllByRole('link')).toHaveLength(NAV_ROUTES.length)
    expect(container.querySelectorAll('.glass-nav-item .glass-nav-item-effect .glass-nav-sample')).toHaveLength(NAV_ROUTES.length)
  })

  it('移除系统级执行机 badge，且不再请求执行机投影', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { container } = render(<MemoryRouter><TopBar /></MemoryRouter>)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="execution-machine"]')).toBeNull()
    expect(screen.queryByText(/执行机：/)).toBeNull()
  })

  it('保留当前对话导航的激活态', () => {
    render(<MemoryRouter initialEntries={['/conversation']}><TopBar /></MemoryRouter>)

    expect(screen.getByRole('link', { name: '对话' }).classList.contains('nav-pill-active')).toBe(true)
    expect(screen.getByRole('link', { name: '设置' }).classList.contains('nav-pill-active')).toBe(false)
  })
})
