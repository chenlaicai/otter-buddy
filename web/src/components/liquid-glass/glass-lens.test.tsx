// @vitest-environment jsdom
// 行为级测试：mock engine（jsdom 无 WebGL2），驱动真实的 GlassLens 生命周期逻辑。
// 覆盖常驻透镜的四个回归点（检视报告 2061 发现 4/5/6）：
//   ①初始挂载即常驻（add+wake，drawn 后 data-glass-moving 在位）
//   ②value→null 时透镜立即退场（detach 必须调度帧，旧玻璃不得残留）
//   ③运行中开启 prefers-reduced-motion 时透镜立即退场（引擎静止无帧，必须显式监听）
//   ④选中项几何变化（RO 触发）时静止透镜重新对位
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
import { useState } from 'react'

type LensViewLike = {
  lens: (refresh: boolean) => { cx: number; hx: number } | null
  drawn?: () => void
  step?: (dt: number, reduced: boolean) => boolean
}

const harness = vi.hoisted(() => {
  const state = {
    views: [] as LensViewLike[],
    wake: 0,
    ioCallback: null as ((entries: { isIntersecting: boolean }[]) => void) | null,
    roCallback: null as (() => void) | null,
    reducedMatches: false,
    reducedListeners: [] as ((e: { matches: boolean }) => void)[],
    boxes: {
      host: { left: 0, top: 0, width: 400, height: 48, right: 400, bottom: 48, x: 0, y: 0 },
      a: { left: 20, top: 4, width: 80, height: 40, right: 100, bottom: 44, x: 20, y: 4 },
      b: { left: 120, top: 4, width: 80, height: 40, right: 200, bottom: 44, x: 120, y: 4 },
    } as Record<string, { left: number; top: number; width: number; height: number; right: number; bottom: number; x: number; y: number }>,
  }
  return state
})

vi.mock('./engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engine')>()
  return {
    ...actual,
    getGlassEngine: () => ({
      add: (v: LensViewLike) => {
        harness.views.push(v)
      },
      remove: (v: LensViewLike) => {
        const i = harness.views.indexOf(v)
        if (i >= 0) harness.views.splice(i, 1)
      },
      wake: () => {
        harness.wake += 1
      },
      resolveColor: () => [1, 1, 1, 1],
    }),
  }
})

import { GlassLens } from './glass-lens'

function Host({ value }: { value: string | null }) {
  return (
    <div data-glass-host="" data-testid="host" style={{ position: 'relative' }}>
      <GlassLens value={value} />
      <button role="radio" data-testid="opt-a" aria-checked={value === 'a'} style={{ position: 'absolute', left: 20, top: 4, width: 80, height: 40 }}>
        {value === 'a' && <span data-glass-highlight="" style={{ position: 'absolute', inset: 0 }} />}
        <span>A</span>
      </button>
      <button role="radio" data-testid="opt-b" aria-checked={value === 'b'} style={{ position: 'absolute', left: 120, top: 4, width: 80, height: 40 }}>
        {value === 'b' && <span data-glass-highlight="" style={{ position: 'absolute', inset: 0 }} />}
        <span>B</span>
      </button>
    </div>
  )
}

/** Controlled host: lets the test flip `value` after mount. */
const hostSwitchSetter: { current: ((v: string | null) => void) | null } = { current: null }
function HostSwitch({ initial }: { initial: string | null }) {
  const [value, setValue] = useState(initial)
  hostSwitchSetter.current = setValue
  return <Host value={value} />
}

function rectOf(el: Element) {
  const testid = el.getAttribute('data-testid') ?? ''
  if (el.hasAttribute('data-glass-host')) return harness.boxes.host
  if (testid === 'opt-a') return harness.boxes.a
  if (testid === 'opt-b') return harness.boxes.b
  const parent = el.parentElement?.getAttribute('data-testid')
  if (parent === 'opt-a') return harness.boxes.a
  if (parent === 'opt-b') return harness.boxes.b
  return harness.boxes.host
}

beforeEach(() => {
  harness.views.length = 0
  harness.wake = 0
  harness.ioCallback = null
  harness.roCallback = null
  harness.reducedMatches = false
  harness.reducedListeners.length = 0
  harness.boxes.b = { left: 120, top: 4, width: 80, height: 40, right: 200, bottom: 44, x: 120, y: 4 }

  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        harness.ioCallback = cb
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        harness.roCallback = cb
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  )
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('reduced-motion') ? harness.reducedMatches : false,
      media: query,
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
        if (query.includes('reduced-motion')) harness.reducedListeners.push(cb)
      },
      removeEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
        const i = harness.reducedListeners.indexOf(cb)
        if (i >= 0) harness.reducedListeners.splice(i, 1)
      },
    })),
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return rectOf(this) as DOMRect
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn() } as unknown as CanvasRenderingContext2D)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const view = (): LensViewLike => harness.views.at(-1) as LensViewLike

describe('GlassLens 常驻生命周期', () => {
  it('初始挂载即常驻：add + wake，IO 置 visible 后再 wake，drawn 后隐藏 DOM 高亮', () => {
    const { getByTestId } = render(<Host value="a" />)
    const host = getByTestId('host') as HTMLElement

    expect(harness.views.length).toBe(1)
    expect(harness.wake).toBeGreaterThanOrEqual(1)

    // engine 首帧在 visible=false 时被跳过；IO 回调置 visible 后必须补 wake（首绘链）
    const wakeBefore = harness.wake
    harness.ioCallback?.([{ isIntersecting: true }])
    expect(harness.wake).toBeGreaterThan(wakeBefore)

    // 第一帧画完：flat highlight 隐藏
    view().drawn?.()
    expect('glassMoving' in host.dataset).toBe(true)
  })

  it('value→null：透镜立即退场（detach 调度帧，旧玻璃不残留）', () => {
    const switcher = render(<HostSwitch initial="a" />)
    harness.ioCallback?.([{ isIntersecting: true }])
    view().drawn?.()
    const host = switcher.getByTestId('host') as HTMLElement
    expect('glassMoving' in host.dataset).toBe(true)

    const wakeBefore = harness.wake
    act(() => {
      hostSwitchSetter.current?.(null)
    })
    const host2 = switcher.getByTestId('host') as HTMLElement

    expect('glassMoving' in host2.dataset).toBe(false)
    expect(harness.wake).toBeGreaterThan(wakeBefore)
    // 透镜已清空
    expect(view().lens(false)).toBeNull()
  })

  it('运行中开启 prefers-reduced-motion：透镜立即退场（引擎静止无帧也要生效）', () => {
    const { getByTestId } = render(<Host value="a" />)
    harness.ioCallback?.([{ isIntersecting: true }])
    view().drawn?.()
    const host = getByTestId('host') as HTMLElement
    expect('glassMoving' in host.dataset).toBe(true)

    harness.reducedMatches = true
    const wakeBefore = harness.wake
    for (const cb of harness.reducedListeners) cb({ matches: true })

    expect('glassMoving' in host.dataset).toBe(false)
    expect(harness.wake).toBeGreaterThan(wakeBefore)
    expect(view().lens(false)).toBeNull()
  })

  it('静止常驻时选中项几何变化（RO 触发）：透镜重新对位', () => {
    render(<Host value="a" />)
    harness.ioCallback?.([{ isIntersecting: true }])
    view().drawn?.()

    // 选中项变宽（如文字/图标尺寸变化），root 尺寸未变
    const wakeBefore = harness.wake
    harness.boxes.a = { left: 20, top: 4, width: 140, height: 40, right: 160, bottom: 44, x: 20, y: 4 }
    harness.roCallback?.()

    expect(harness.wake).toBeGreaterThan(wakeBefore)
    const lens = view().lens(false)
    expect(lens).not.toBeNull()
    // 透镜中心跟随新盒子（x=20+140/2=90，lens cx 含 padX 偏移，这里断言它离开旧中心 60）
    expect(lens!.cx).toBeGreaterThan(70)
    expect(lens!.hx).toBeGreaterThan(40)
  })

  it('prefers-reduced-motion 开→关往返：关闭后透镜恢复常驻', () => {
    const { getByTestId } = render(<Host value="a" />)
    harness.ioCallback?.([{ isIntersecting: true }])
    view().drawn?.()
    const host = getByTestId('host') as HTMLElement

    // 开启：退场
    harness.reducedMatches = true
    for (const cb of harness.reducedListeners) cb({ matches: true })
    expect('glassMoving' in host.dataset).toBe(false)
    expect(view().lens(false)).toBeNull()

    // 关闭：重新常驻（detach 保留了 target，不能被 sync 的 same 判断拦住）
    harness.reducedMatches = false
    for (const cb of harness.reducedListeners) cb({ matches: false })
    expect(view().lens(false)).not.toBeNull()
    // 引擎画完首帧后（drawn 回调）DOM 高亮才隐藏
    view().drawn?.()
    expect('glassMoving' in host.dataset).toBe(true)
  })

  it('按压中 RO 被跳过，释放后透镜重对位新几何', async () => {
    const { getByTestId } = render(<Host value="a" />)
    harness.ioCallback?.([{ isIntersecting: true }])
    view().drawn?.()
    const optA = getByTestId('opt-a')

    // 按压选中项（onDown：pressed=true）
    fireEvent.pointerDown(optA, { button: 0 })

    // 按压中几何变化：RO 被忽略
    harness.boxes.a = { left: 20, top: 4, width: 200, height: 40, right: 220, bottom: 44, x: 20, y: 4 }
    harness.roCallback?.()
    expect(view().lens(false)!.hx).toBeLessThan(80) // 仍是旧宽度（80/2 附近）

    // 释放：onUp 里 sync(false) 重读几何
    fireEvent.pointerUp(optA)
    const lens = view().lens(false)
    expect(lens).not.toBeNull()
    expect(lens!.hx).toBeGreaterThan(80) // 新宽度 200/2 量级（含 swell/pad 换算）
  })

  it('离屏清空 value 后回视口：IO arm 必须调度清帧，旧画布不得残留', () => {
    const switcher = render(<HostSwitch initial="a" />)
    harness.ioCallback?.([{ isIntersecting: true }])
    view().drawn?.()

    // 滚离屏（帧被 engine 跳过，canvas 上仍是旧玻璃帧）
    harness.ioCallback?.([{ isIntersecting: false }])
    // 离屏中清空 value：detach 生效但 dirty 无帧消费
    act(() => {
      hostSwitchSetter.current?.(null)
    })
    const host = switcher.getByTestId('host') as HTMLElement
    expect('glassMoving' in host.dataset).toBe(false)

    // 回视口：IO 的 arm 分支——active 已为 false，必须补 wake 消费 dirty 清帧
    const wakeBefore = harness.wake
    harness.ioCallback?.([{ isIntersecting: true }])
    expect(harness.wake).toBeGreaterThan(wakeBefore)
    expect(view().lens(false)).toBeNull()
  })
})
