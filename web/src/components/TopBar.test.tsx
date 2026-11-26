// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { NAV_ROUTES } from '@contract/web/pages'
import type { GlassLensProps } from './liquid-glass/glass-lens'

const mocks = vi.hoisted(() => ({ lensProps: {} as GlassLensProps }))

vi.mock('./liquid-glass/glass-lens', () => ({
  GlassLens: (props: GlassLensProps) => {
    mocks.lensProps = props
    return <canvas data-testid="liquid-glass-lens" aria-hidden="true" />
  },
}))

import { TopBar } from './TopBar'

describe('TopBar 悬浮主导航', () => {
  function NavigationButton({ to }: { to: string }) {
    const navigate = useNavigate()
    return <button onClick={() => navigate(to)}>测试跳转</button>
  }

  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('左侧保留系统图标与名称，中央导航使用开源 GlassLens 且只有一枚高亮占位元素（常驻透镜绘制时隐藏）', () => {
    const { container } = render(<MemoryRouter initialEntries={['/conversation']}><TopBar /></MemoryRouter>)

    expect(screen.getByRole('img', { name: 'Otter Buddy' })).toBeTruthy()
    expect(screen.getByTestId('system-brand').textContent).toBe('Otter Buddy')
    expect(screen.getAllByTestId('liquid-glass-lens')).toHaveLength(1)
    expect(mocks.lensProps.value).toBe('/conversation')
    expect(mocks.lensProps.disabled).toBe(false)
    expect(screen.getAllByRole('link')).toHaveLength(NAV_ROUTES.length)
    expect(container.querySelectorAll('[data-glass-highlight]')).toHaveLength(1)
    expect(screen.getByRole('link', { name: '对话' }).querySelector('.glass-nav-highlight')).not.toBeNull()
    expect(container.querySelector('feTurbulence')).toBeNull()
    expect(container.querySelector('.glass-nav-copy')).toBeNull()
  })

  it('移除系统级执行机 badge，且不再请求执行机投影', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { container } = render(<MemoryRouter><TopBar /></MemoryRouter>)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="execution-machine"]')).toBeNull()
    expect(screen.queryByText(/执行机：/)).toBeNull()
  })

  it('保留当前对话导航的激活态和真实链接语义', () => {
    render(<MemoryRouter initialEntries={['/conversation']}><TopBar /></MemoryRouter>)

    const active = screen.getByRole('link', { name: '对话' })
    expect(active.classList.contains('nav-pill-active')).toBe(true)
    expect(active.getAttribute('role')).toBeNull()
    expect(active.getAttribute('href')).toBe('/conversation')
    expect(active.getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: '设置' }).classList.contains('nav-pill-active')).toBe(false)
  })

  it('路由切换只更新开源透镜的 value 与静止高亮，不再创建手写动画', () => {
    const { container } = render(<MemoryRouter initialEntries={['/conversation']}><TopBar /></MemoryRouter>)

    fireEvent.click(screen.getByRole('link', { name: '设置' }))
    expect(mocks.lensProps.value).toBe('/settings')
    expect(container.querySelectorAll('[data-glass-highlight]')).toHaveLength(1)
    expect(screen.getByRole('link', { name: '设置' }).querySelector('[data-glass-highlight]')).not.toBeNull()
    expect(container.querySelectorAll('[data-glass-option]')).toHaveLength(NAV_ROUTES.length)
  })

  it('快速连点始终只保留最新目标与一枚静止高亮', () => {
    const { container } = render(<MemoryRouter initialEntries={['/conversation']}><TopBar /></MemoryRouter>)

    fireEvent.click(screen.getByRole('link', { name: '设置' }))
    fireEvent.click(screen.getByRole('link', { name: '记忆召回' }))
    fireEvent.click(screen.getByRole('link', { name: '健康面板' }))
    expect(mocks.lensProps.value).toBe('/health')
    expect(container.querySelectorAll('[data-glass-highlight]')).toHaveLength(1)
    expect(screen.getByRole('link', { name: '健康面板' }).querySelector('[data-glass-highlight]')).not.toBeNull()
  })

  it('减少透明度时禁用 WebGL 透镜，保留静态选中块', () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(prefers-reduced-transparency: reduce)',
      media: query,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })))
    const { container } = render(<MemoryRouter initialEntries={['/conversation']}><TopBar /></MemoryRouter>)

    expect(mocks.lensProps.disabled).toBe(true)
    expect(container.querySelectorAll('[data-glass-highlight]')).toHaveLength(1)
  })

  it('无激活路由清空透镜与静止高亮', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/settings']}>
        <TopBar />
        <NavigationButton to="/outside" />
      </MemoryRouter>,
    )
    expect(mocks.lensProps.value).toBe('/settings')
    fireEvent.click(screen.getByRole('button', { name: '测试跳转' }))
    expect(mocks.lensProps.value).toBeNull()
    expect(container.querySelectorAll('[data-glass-highlight]')).toHaveLength(0)
  })

  it('对话详情保留对话入口激活态', () => {
    render(
      <MemoryRouter initialEntries={['/conversation']}>
        <TopBar />
        <NavigationButton to="/conversation/abc" />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: '测试跳转' }))
    expect(mocks.lensProps.value).toBe('/conversation')
    expect(screen.getByRole('link', { name: '对话' }).dataset.active).toBe('true')
    expect(screen.getByRole('link', { name: '对话' }).getAttribute('aria-current')).toBe('page')
  })
})
