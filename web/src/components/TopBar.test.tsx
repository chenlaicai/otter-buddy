// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { NAV_ROUTES } from '@contract/web/pages'
import type { GlassProps, GlassMotionValue } from '@samasante/liquid-glass'

const mocks = vi.hoisted(() => ({
  animate: vi.fn(),
  stop: vi.fn(),
  glassProps: {} as GlassProps,
}))
const signal = (value: unknown) => value as GlassMotionValue

vi.mock('@samasante/liquid-glass', () => {
  const glassValue = (initial: number) => {
    let current = initial
    const listeners = new Set<(value: number) => void>()
    return {
      get: () => current,
      set: (value: number) => { current = value; listeners.forEach(listener => listener(value)) },
      on: (_event: 'change', listener: (value: number) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
  }
  return {
    Glass: ({ children, refract, ...props }: GlassProps) => {
      mocks.glassProps = props
      return <div data-testid="liquid-glass-lens"><div>{children}</div><div data-testid="refract-copy">{refract}</div></div>
    },
    glassValue,
    deriveGlass: (dependencies: ReturnType<typeof glassValue>[], compute: () => number) => {
      const derived = glassValue(compute())
      dependencies.forEach(dependency => dependency.on('change', () => derived.set(compute())))
      return derived
    },
    animateGlassValue: mocks.animate.mockImplementation((signal, target) => {
      signal.set(target)
      return { stop: mocks.stop }
    }),
    cubicBezier: () => (value: number) => value,
    useLensWobble: vi.fn(),
  }
})

import { TopBar } from './TopBar'

describe('TopBar 悬浮主导航', () => {
  function NavigationButton({ to }: { to: string }) {
    const navigate = useNavigate()
    return <button onClick={() => navigate(to)}>测试跳转</button>
  }

  beforeEach(() => {
    mocks.animate.mockClear()
    mocks.stop.mockClear()
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
    vi.useRealTimers()
  })

  function mockNavGeometry() {
    const rect = (left: number, width: number) => ({
      left, width, right: left + width, top: 0, bottom: 40, height: 40, x: left, y: 0,
      toJSON: () => ({}),
    }) as DOMRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('glass-nav')) return rect(100, 700)
      if (this.classList.contains('glass-nav-item')) {
        const index = NAV_ROUTES.findIndex(route => route.label ? this.textContent?.includes(route.label) : false)
        return rect(100 + Math.max(0, index) * 100, 80)
      }
      return rect(100, 80)
    })
  }

  it('左侧保留系统图标与系统名称，中央菜单只有一枚静止也折射的开源玻璃透镜', () => {
    mockNavGeometry()
    const { container } = render(<MemoryRouter><TopBar /></MemoryRouter>)

    expect(screen.getByRole('img', { name: 'Otter Buddy' })).toBeTruthy()
    expect(screen.getByTestId('system-brand').textContent).toBe('Otter Buddy')
    expect(screen.getByText('Otter Buddy')).toBeTruthy()
    expect(container.querySelector('header')?.classList.contains('glass-strong')).toBe(false)
    expect(screen.getByRole('navigation', { name: '主导航' }).classList.contains('glass-nav')).toBe(true)
    expect(screen.getAllByTestId('liquid-glass-lens')).toHaveLength(1)
    expect(container.querySelectorAll('.glass-nav-copy .glass-nav-static-surface')).toHaveLength(2)
    expect(container.querySelectorAll('.glass-nav-item .glass-nav-copy')).toHaveLength(0)
    expect(container.querySelector('feTurbulence')).toBeNull()
    expect(mocks.glassProps.style?.position).toBe('absolute')
    expect(mocks.glassProps.pixelUnits).toBe(true)
    expect(mocks.glassProps.optics?.dispersion).toBe(0)
    expect(signal(mocks.glassProps.unstable_lens?.edgeBias).get()).toBeCloseTo(0.5)
    expect(signal(mocks.glassProps.scale).get()).toBeCloseTo(0.4088)
    expect(signal(mocks.glassProps.unstable_lens?.tintOpacity).get()).toBeCloseTo(0.28)
    expect(screen.getAllByRole('link')).toHaveLength(NAV_ROUTES.length)
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

  it('位置、尺寸和 tint 使用独立信号，正反向都在目标项收缩', () => {
    mockNavGeometry()
    vi.useFakeTimers()
    render(<MemoryRouter initialEntries={['/conversation']}><TopBar /></MemoryRouter>)

    fireEvent.click(screen.getByRole('link', { name: '设置' }))
    expect(mocks.animate).toHaveBeenCalledTimes(6)
    expect(mocks.animate.mock.calls[0][1]).toBe(640)
    expect(mocks.animate.mock.calls[0][2]).toMatchObject({ duration: 0.29 })
    expect(mocks.animate.mock.calls[1][1]).toBe(92)
    expect(mocks.animate.mock.calls[2][1]).toBe(43)
    expect(mocks.animate.mock.calls[4][1]).toBe(0)

    vi.advanceTimersByTime(160)
    expect(mocks.animate).toHaveBeenCalledTimes(11)
    expect(mocks.animate.mock.calls[6][1]).toBe(80)
    expect(mocks.animate.mock.calls[7][1]).toBe(30)
    expect(mocks.animate.mock.calls[9][1]).toBe(0.28)

    fireEvent.click(screen.getByRole('link', { name: '对话' }))
    expect(mocks.animate.mock.calls[11][1]).toBe(40)
    expect(mocks.animate.mock.calls[11][2]).toMatchObject({ duration: 0.29 })
  })

  it('减少动态效果时不创建运动动画，透镜直接到位', () => {
    mockNavGeometry()
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })))
    render(<MemoryRouter initialEntries={['/conversation']}><TopBar /></MemoryRouter>)
    mocks.animate.mockClear()

    fireEvent.click(screen.getByRole('link', { name: '设置' }))
    expect(mocks.animate).not.toHaveBeenCalled()
    expect(signal(mocks.glassProps.center?.x).get()).toBeCloseTo((24 + 640) / 748)
    expect(signal((mocks.glassProps.size as unknown[])[0]).get()).toBe(80)
  })

  it('快速连点停止旧信号动画并接续到新目标', () => {
    mockNavGeometry()
    render(<MemoryRouter initialEntries={['/conversation']}><TopBar /></MemoryRouter>)
    fireEvent.click(screen.getByRole('link', { name: '设置' }))
    mocks.stop.mockClear()

    fireEvent.click(screen.getByRole('link', { name: '对话' }))
    expect(mocks.stop).toHaveBeenCalled()
    expect(mocks.animate.mock.calls.at(-6)?.[1]).toBe(40)
  })

  it('无激活路由卸载旧透镜，对话详情仍激活对话入口', () => {
    mockNavGeometry()
    const { container } = render(
      <MemoryRouter initialEntries={['/settings']}>
        <TopBar />
        <NavigationButton to="/outside" />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('liquid-glass-lens')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '测试跳转' }))
    expect(container.querySelector('[data-testid="liquid-glass-lens"]')).toBeNull()
    expect(container.querySelectorAll('.glass-nav-selection')).toHaveLength(0)
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

  it('动画进行中 resize 取消旧动画并贴合当前目标', () => {
    mockNavGeometry()
    render(<MemoryRouter initialEntries={['/conversation']}><TopBar /></MemoryRouter>)
    fireEvent.click(screen.getByRole('link', { name: '设置' }))
    mocks.stop.mockClear()

    fireEvent.resize(window)
    expect(mocks.stop).toHaveBeenCalled()
    expect(signal(mocks.glassProps.center?.x).get()).toBeCloseTo((24 + 640) / 748)
    expect(signal((mocks.glassProps.size as unknown[])[0]).get()).toBe(80)
  })

  it('减少透明度时卸载折射库，保留实色选中块', () => {
    mockNavGeometry()
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(prefers-reduced-transparency: reduce)',
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })))
    const { container } = render(<MemoryRouter initialEntries={['/conversation']}><TopBar /></MemoryRouter>)

    expect(container.querySelector('[data-testid="liquid-glass-lens"]')).toBeNull()
    const selection = container.querySelector<HTMLElement>('.glass-nav-selection')!
    expect(selection.style.left).toBe('0px')
    expect(selection.style.width).toBe('80px')
  })
})
