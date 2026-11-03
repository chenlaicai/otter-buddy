import { useId, type CSSProperties, type ReactNode } from 'react'

export function LensFilter({ id, width, height, shape, strength = 0.65 }: { id: string; width: number; height: number; shape: 'circle' | 'squircle'; strength?: number }) {
  return (
    <defs>
      <filter id={id} filterUnits="userSpaceOnUse" x="0" y="0" width={width} height={height} colorInterpolationFilters="sRGB">
        <feImage href={`/glass/lens-${shape}.png`} x="0" y="0" width={width} height={height} preserveAspectRatio="none" result="lens-map" />
        <feDisplacementMap in="SourceGraphic" in2="lens-map" scale={Math.min(width, height) * strength} xChannelSelector="R" yChannelSelector="G" result="refracted" />
        <feOffset in="refracted" dx="-0.3" dy="0" result="spectral-left" />
        <feColorMatrix in="spectral-left" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.22 0" result="red-edge" />
        <feOffset in="refracted" dx="0.3" dy="0" result="spectral-right" />
        <feColorMatrix in="spectral-right" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 0.18 0" result="blue-edge" />
        <feBlend in="refracted" in2="red-edge" mode="screen" result="red-blend" />
        <feBlend in="red-blend" in2="blue-edge" mode="screen" />
      </filter>
    </defs>
  )
}

export function OpticalGlassLayers({ width, height, shape, contentClassName, strength, children }: {
  width: number
  height: number
  shape: 'circle' | 'squircle'
  contentClassName: string
  strength?: number
  children: ReactNode
}) {
  const filterId = `optical-glass-${useId().replaceAll(':', '')}`
  return (
    <>
      <svg aria-hidden className="optical-glass__filter" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <LensFilter id={filterId} width={width} height={height} shape={shape} strength={strength} />
      </svg>
      <span aria-hidden className="optical-glass__lens" style={{ '--glass-filter': `url(#${filterId})` } as CSSProperties} />
      <span aria-hidden className="optical-glass__light" />
      <span className={contentClassName}>{children}</span>
    </>
  )
}
