import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { MessageCircle, Search, Package, Settings, Activity, ClipboardList, type LucideIcon } from 'lucide-react'
import {
  Glass,
  animateGlassValue,
  cubicBezier,
  deriveGlass,
  glassValue,
  useLensWobble,
  type GlassAnimation,
} from '@samasante/liquid-glass'
import { NAV_ROUTES } from '@contract/web/pages'

const ICONS: Record<string, LucideIcon> = {
  '/conversation': MessageCircle,
  '/memory': Search,
  '/skills': Package,
  '/im': MessageCircle,
  '/health': Activity,
  '/activity': ClipboardList,
  '/settings': Settings,
}

const LENS_PAD = 24
const REST_LENS_HEIGHT = 30
const EXPANDED_LENS_HEIGHT = 43
const POSITION_EASE = cubicBezier(0.34, 1.2, 0.42, 1)
const SETTLE_EASE = cubicBezier(0.36, 0, 0.18, 1)

type SelectionBox = { left: number; width: number }
type LensTarget = { center: number; width: number; route: string }

/** SPA TopBar —— 独立系统图标 + 居中 Liquid Glass 主导航，由 AppLayout 渲染一次。 */
export function TopBar() {
  const location = useLocation()
  const contentRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const animationsRef = useRef<GlassAnimation[]>([])
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const activeRouteRef = useRef<string | undefined>(undefined)
  const visibleRef = useRef(false)
  const fullWidthRef = useRef(604 + LENS_PAD * 2)
  const holdRef = useRef(0)
  const kickWobbleRef = useRef<() => void>(() => {})
  const [selectionBox, setSelectionBox] = useState<SelectionBox>({ left: 0, width: 0 })
  const [navWidth, setNavWidth] = useState(604)
  const [visible, setVisible] = useState(false)
  const [reducedTransparency, setReducedTransparency] = useState(false)

  const mv = useMemo(() => {
    const center = glassValue(43)
    const baseW = glassValue(70)
    const baseH = glassValue(REST_LENS_HEIGHT)
    const radius = glassValue(REST_LENS_HEIGHT / 2)
    const tintOpacity = glassValue(0.28)
    const shadowOpacity = glassValue(0)
    const stretch = glassValue(0)
    const lensX = deriveGlass([center], () => (LENS_PAD + center.get()) / fullWidthRef.current)
    const lensW = deriveGlass([baseW, stretch], () => baseW.get() * (1 - 0.12 * stretch.get()))
    const lensH = deriveGlass([baseH, stretch], () => baseH.get() * (1 + 0.42 * stretch.get()))
    const restShadowOpacity = deriveGlass([shadowOpacity], () => 1 - shadowOpacity.get())
    // 静止与运动都保留真实折射；运动时只略增强，不在停下后退回薄纱。
    const opticScale = deriveGlass([tintOpacity], () => 0.38 + (1 - tintOpacity.get()) * 0.04)
    const edgeBias = deriveGlass([tintOpacity], () => Math.min(0.5, (tintOpacity.get() / 0.28) * 0.5))
    return { center, baseW, baseH, radius, tintOpacity, shadowOpacity, stretch, lensX, lensW, lensH, restShadowOpacity, opticScale, edgeBias }
  }, [])
  useLensWobble(mv.center, mv.stretch, holdRef, kickWobbleRef)

  function isActive(path: string): boolean {
    if (path === '/conversation') {
      return location.pathname === '/conversation'
        || location.pathname === '/'
        || location.pathname.startsWith('/conversation/')
    }
    return location.pathname === path
  }

  function stopAnimations() {
    animationsRef.current.forEach(animation => animation.stop())
    animationsRef.current = []
    clearTimeout(collapseTimerRef.current)
  }

  function animateTo(signal: Parameters<typeof animateGlassValue>[0], target: number, options: Parameters<typeof animateGlassValue>[2]) {
    const animation = animateGlassValue(signal, target, options)
    animationsRef.current.push(animation)
  }

  function measureTarget(): LensTarget | undefined {
    const nav = navRef.current
    const activeLink = contentRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    if (!nav || !activeLink) return undefined
    const navRect = nav.getBoundingClientRect()
    const linkRect = activeLink.getBoundingClientRect()
    fullWidthRef.current = navRect.width + LENS_PAD * 2
    setNavWidth(navRect.width)
    return {
      center: linkRect.left - navRect.left + linkRect.width / 2,
      width: linkRect.width,
      route: activeLink.dataset.route ?? '',
    }
  }

  function snap(target: LensTarget) {
    stopAnimations()
    mv.center.set(target.center)
    mv.baseW.set(target.width)
    mv.baseH.set(REST_LENS_HEIGHT)
    mv.radius.set(REST_LENS_HEIGHT / 2)
    mv.tintOpacity.set(0.28)
    mv.shadowOpacity.set(0)
    mv.stretch.set(0)
    activeRouteRef.current = target.route
    visibleRef.current = true
    setVisible(true)
    setSelectionBox({ left: target.center - target.width / 2, width: target.width })
  }

  function measureSelection(animate: boolean) {
    const target = measureTarget()
    if (!target) {
      stopAnimations()
      activeRouteRef.current = undefined
      visibleRef.current = false
      setVisible(false)
      setSelectionBox({ left: 0, width: 0 })
      return
    }

    setSelectionBox({ left: target.center - target.width / 2, width: target.width })
    const previousRoute = activeRouteRef.current
    const reducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const shouldAnimate = animate && visibleRef.current && previousRoute && previousRoute !== target.route && !reducedMotion
    if (!shouldAnimate) {
      snap(target)
      return
    }

    stopAnimations()
    activeRouteRef.current = target.route
    visibleRef.current = true
    setVisible(true)
    // 位置、速度形变、尺寸和灰色 tint 分开驱动；快速连点继承信号的当前值。
    animateTo(mv.center, target.center, { duration: 0.29, ease: POSITION_EASE })
    animateTo(mv.baseW, target.width + 12, { duration: 0.085, ease: POSITION_EASE })
    animateTo(mv.baseH, EXPANDED_LENS_HEIGHT, { duration: 0.085, ease: POSITION_EASE })
    animateTo(mv.radius, EXPANDED_LENS_HEIGHT / 2, { duration: 0.085, ease: POSITION_EASE })
    animateTo(mv.tintOpacity, 0, { duration: 0.085, ease: SETTLE_EASE })
    animateTo(mv.shadowOpacity, 1, { duration: 0.085, ease: SETTLE_EASE })
    collapseTimerRef.current = setTimeout(() => {
      animateTo(mv.baseW, target.width, { duration: 0.14, ease: SETTLE_EASE })
      animateTo(mv.baseH, REST_LENS_HEIGHT, { duration: 0.14, ease: SETTLE_EASE })
      animateTo(mv.radius, REST_LENS_HEIGHT / 2, { duration: 0.14, ease: SETTLE_EASE })
      animateTo(mv.tintOpacity, 0.28, { duration: 0.14, ease: SETTLE_EASE })
      animateTo(mv.shadowOpacity, 0, { duration: 0.14, ease: SETTLE_EASE })
    }, 160)
  }

  useLayoutEffect(() => {
    measureSelection(true)
    // 仅路由变化触发；几何由当前 DOM 与持久 motion signals 读取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  useEffect(() => {
    const onResize = () => measureSelection(false)
    const motionPreference = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
    const transparencyPreference = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-transparency: reduce)')
      : null
    const onPreferenceChange = () => measureSelection(false)
    const onTransparencyChange = () => setReducedTransparency(transparencyPreference?.matches ?? false)
    onTransparencyChange()
    window.addEventListener('resize', onResize)
    motionPreference?.addEventListener?.('change', onPreferenceChange)
    transparencyPreference?.addEventListener?.('change', onTransparencyChange)
    return () => {
      stopAnimations()
      window.removeEventListener('resize', onResize)
      motionPreference?.removeEventListener?.('change', onPreferenceChange)
      transparencyPreference?.removeEventListener?.('change', onTransparencyChange)
    }
    // 监听器只挂载一次，避免路由 cleanup 清掉进行中的 collapse。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fullWidth = navWidth + LENS_PAD * 2
  const staticSurface = (
    <div className="glass-nav-static-surface" style={{ width: navWidth }}>
      <span className="glass-nav-tint" />
    </div>
  )

  return (
    <header className="relative z-20 mx-3 mt-3 flex h-12 flex-shrink-0 items-center justify-center">
      <img
        src="/otter-icon.png"
        alt="Otter Buddy"
        className="absolute left-2 top-1/2 h-8 w-8 -translate-y-1/2 rounded-full shadow-otter"
      />

      <nav ref={navRef} aria-label="主导航" data-testid="primary-nav" className="glass-nav max-w-[calc(100vw-6rem)] rounded-full">
        {visible && !reducedTransparency && (
          <Glass
            className="glass-nav-lens"
            optics={{
              mapSize: 512, depth: 0.5, dispersion: 0, strength: 0.3,
              clipToShape: true, softEdge: true, curvature: 0.5, splay: 0.42,
              bend: 0.34, bendWidth: 0.11, frost: 0, brightness: 0,
              specular: 0.86, sheenAngle: 40, sheenDark: false,
              glow: 0.08, glowSpread: 0.52, glowFalloff: 1.6,
              sheen: 0.46, sheenWidth: 1.6, sheenFalloff: 1.3,
              edgeShadow: '0 3px 8px rgba(45,42,38,.13)',
              edgeInsetShadow: '0 -3px 8px rgba(45,42,38,.08)',
              restEdgeShadow: '0 1px 2px rgba(45,42,38,.12), 0 3px 8px rgba(45,42,38,.06)',
            }}
            center={{ x: mv.lensX, y: 0.5 }}
            scale={mv.opticScale}
            size={[mv.lensW, mv.lensH]}
            radius={mv.radius}
            behind="transparent"
            pixelUnits
            filterResolution={2}
            unstable_lens={{
              tintColor: '#c9c7c2', tintOpacity: mv.tintOpacity,
              shadowOpacity: mv.shadowOpacity, restShadowOpacity: mv.restShadowOpacity,
              edgeBias: mv.edgeBias,
            }}
            style={{ position: 'absolute', left: -LENS_PAD, top: -LENS_PAD, width: fullWidth, height: 40 + LENS_PAD * 2 }}
            refract={<div className="glass-nav-copy">{staticSurface}</div>}
          >
            <div className="glass-nav-copy">{staticSurface}</div>
          </Glass>
        )}
        {visible && reducedTransparency && (
          <span aria-hidden="true" className="glass-nav-selection" style={selectionBox} />
        )}
        <div ref={contentRef} className="glass-nav-content flex items-center gap-0.5 overflow-x-auto p-1" onScroll={() => measureSelection(false)}>
          {NAV_ROUTES.map(route => {
            const Icon = ICONS[route.path] ?? MessageCircle
            const active = isActive(route.path)
            return (
              <Link
                key={route.path}
                to={route.nav ?? route.path}
                className={`glass-nav-item flex shrink-0 items-center rounded-full px-4 py-1.5 text-xs font-medium transition ${
                  active ? 'nav-pill-active text-stone-800 font-semibold' : 'text-stone-700 hover:text-stone-900'
                }`}
                data-active={active}
                data-route={route.path}
                aria-current={active ? 'page' : undefined}
              >
                <span className="glass-nav-item-content flex items-center gap-1.5">
                  <Icon className="w-3.5 h-3.5" />
                  {route.label}
                </span>
              </Link>
            )
          })}
        </div>
      </nav>
    </header>
  )
}
