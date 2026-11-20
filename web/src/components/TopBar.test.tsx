// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { TopBar } from './TopBar'
import { NAV_ROUTES } from '@contract/web/pages'

describe('TopBar 悬浮主导航', () => {
  function NavigationButton({ to }: { to: string }) {
    const navigate = useNavigate()
    return <button onClick={() => navigate(to)}>测试跳转</button>
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
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
    expect(container.querySelectorAll('.glass-nav-selection')).toHaveLength(1)
    expect(container.querySelectorAll('.glass-nav-selection .glass-nav-item-effect .glass-nav-sample')).toHaveLength(1)
    expect(container.querySelectorAll('.glass-nav-item .glass-nav-item-effect')).toHaveLength(0)
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

  function mockNavGeometry() {
    const rect = (left: number, width: number) => ({
      left, width, right: left + width, top: 0, bottom: 40, height: 40, x: left, y: 0,
      toJSON: () => ({}),
    }) as DOMRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('glass-nav-content')) return rect(100, 700)
      if (this.classList.contains('glass-nav-item')) {
        const index = NAV_ROUTES.findIndex(route => route.label ? this.textContent?.includes(route.label) : false)
        return rect(100 + Math.max(0, index) * 100, 80)
      }
      return rect(100, 80)
    })
  }

  it('420ms 中间帧连接起终点，正向与反向切换后都收回目标项', () => {
    mockNavGeometry()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    const { container } = render(<MemoryRouter initialEntries={['/conversation']}><TopBar /></MemoryRouter>)
    const selection = container.querySelector<HTMLElement>('.glass-nav-selection')!
    const animate = vi.fn()
    selection.animate = animate
    selection.getAnimations = vi.fn(() => [])

    fireEvent.click(screen.getByRole('link', { name: '设置' }))
    expect(animate).toHaveBeenCalledTimes(1)
    expect(animate.mock.calls[0][1]).toEqual({ duration: 420, easing: 'cubic-bezier(0.22, 0.8, 0.24, 1)' })
    expect(animate.mock.calls[0][0]).toEqual([
      { left: '0px', width: '80px' },
      { left: '0px', width: '680px', offset: 0.48 },
      { left: '600px', width: '80px' },
    ])

    fireEvent.click(screen.getByRole('link', { name: '对话' }))
    expect(animate).toHaveBeenCalledTimes(2)
    expect(animate.mock.calls[1][0]).toEqual([
      { left: '600px', width: '80px' },
      { left: '0px', width: '680px', offset: 0.48 },
      { left: '0px', width: '80px' },
    ])
  })

  it('减少动态效果时选中透镜直接到位', () => {
    mockNavGeometry()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const { container } = render(<MemoryRouter initialEntries={['/conversation']}><TopBar /></MemoryRouter>)
    const selection = container.querySelector<HTMLElement>('.glass-nav-selection')!
    const animate = vi.fn()
    selection.animate = animate

    fireEvent.click(screen.getByRole('link', { name: '设置' }))
    expect(animate).not.toHaveBeenCalled()
    expect(selection.style.left).toBe('600px')
    expect(selection.style.width).toBe('80px')
  })

  it('快速连点从真实中间帧接续，并取消旧时间轴', () => {
    mockNavGeometry()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    const { container } = render(<MemoryRouter initialEntries={['/conversation']}><TopBar /></MemoryRouter>)
    const selection = container.querySelector<HTMLElement>('.glass-nav-selection')!
    const animate = vi.fn()
    selection.animate = animate
    selection.getAnimations = vi.fn(() => [])
    fireEvent.click(screen.getByRole('link', { name: '设置' }))

    const cancel = vi.fn()
    selection.getAnimations = vi.fn(() => [{ playState: 'running', cancel } as unknown as Animation])
    selection.getBoundingClientRect = vi.fn(() => ({
      left: 350, width: 200, right: 550, top: 0, bottom: 40, height: 40, x: 350, y: 0,
      toJSON: () => ({}),
    }) as DOMRect)
    fireEvent.click(screen.getByRole('link', { name: '对话' }))

    expect(cancel).toHaveBeenCalledOnce()
    expect(animate.mock.calls[1][0]).toEqual([
      { left: '250px', width: '200px' },
      { left: '0px', width: '450px', offset: 0.48 },
      { left: '0px', width: '80px' },
    ])
  })

  it('无激活路由清空旧透镜，对话详情仍激活对话入口', () => {
    mockNavGeometry()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    const { container } = render(
      <MemoryRouter initialEntries={['/settings']}>
        <TopBar />
        <NavigationButton to="/outside" />
      </MemoryRouter>,
    )
    const selection = container.querySelector<HTMLElement>('.glass-nav-selection')!
    const cancel = vi.fn()
    selection.getAnimations = vi.fn(() => [{ playState: 'running', cancel } as unknown as Animation])
    fireEvent.click(screen.getByRole('button', { name: '测试跳转' }))
    expect(cancel).toHaveBeenCalledOnce()
    expect(selection.style.visibility).toBe('hidden')
    expect(selection.style.width).toBe('0px')
  })

  it('对话详情保留对话入口激活态', () => {
    render(
      <MemoryRouter initialEntries={['/conversation']}>
        <TopBar />
        <NavigationButton to="/conversation/abc" />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: '测试跳转' }))
    expect(screen.getByRole('link', { name: '对话' }).dataset.active).toBe('true')
    expect(screen.getByRole('link', { name: '对话' }).getAttribute('aria-current')).toBe('page')
  })

  it('动画进行中 resize 立即取消旧几何并落在当前目标', () => {
    mockNavGeometry()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    const { container } = render(<MemoryRouter initialEntries={['/conversation']}><TopBar /></MemoryRouter>)
    const selection = container.querySelector<HTMLElement>('.glass-nav-selection')!
    selection.animate = vi.fn()
    const cancel = vi.fn()
    selection.getAnimations = vi.fn(() => [{ playState: 'running', cancel } as unknown as Animation])

    fireEvent.click(screen.getByRole('link', { name: '设置' }))
    fireEvent.resize(window)
    expect(cancel).toHaveBeenCalled()
    expect(selection.style.left).toBe('600px')
    expect(selection.style.width).toBe('80px')
  })
})
