import { useId, type ButtonHTMLAttributes, type CSSProperties } from 'react'

interface OpticalGlassButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  width: number
  height: number
  radius: number
  shape?: 'circle' | 'squircle'
  /** 受控排版入口，避免调用方手写不存在的一次性类名。 */
  textSize?: number
  textWeight?: number
}

/**
 * F20261103lglct：小交互面的光学玻璃——折射源是静态画布，不采样消息流。
 *
 * Why: 通用 Liquid Glass 库的 Safari 兜底会复制并逐帧对齐真实 DOM；这里把静态
 * 画布作为按钮自身背景再施加持定位移，保留折射而不恢复运行中 DOM 重采样。
 * 内容层在滤镜之外，图标/文字不被折射，也不参与纹理计算。
 */
export function OpticalGlassButton({
  width,
  height,
  radius,
  shape = 'circle',
  className = '',
  style,
  children,
  type = 'button',
  textSize,
  textWeight,
  ...buttonProps
}: OpticalGlassButtonProps) {
  const filterId = `optical-glass-${useId().replaceAll(':', '')}`
  const glassStyle = {
    ...style,
    width,
    height,
    '--glass-radius': `${radius}px`,
    fontSize: textSize,
    fontWeight: textWeight,
  } as CSSProperties
  const lensStyle = {
    '--glass-filter': `url(#${filterId})`,
  } as CSSProperties

  return (
    <button
      {...buttonProps}
      type={type}
      className={`optical-glass ${className}`}
      style={glassStyle}
      data-optical-glass={shape}
    >
      <svg
        aria-hidden
        className="optical-glass__filter"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
      >
        <defs>
          <filter id={filterId} filterUnits="userSpaceOnUse" x="0" y="0" width={width} height={height} colorInterpolationFilters="sRGB">
            <feImage href={`/glass/lens-${shape}.png`} x="0" y="0" width={width} height={height} preserveAspectRatio="none" result="lens-map" />
            <feDisplacementMap in="SourceGraphic" in2="lens-map" scale={Math.min(width, height) * 0.4} xChannelSelector="R" yChannelSelector="G" result="refracted" />
            <feOffset in="refracted" dx="-0.3" dy="0" result="spectral-left" />
            <feColorMatrix in="spectral-left" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.22 0" result="red-edge" />
            <feOffset in="refracted" dx="0.3" dy="0" result="spectral-right" />
            <feColorMatrix in="spectral-right" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 0.18 0" result="blue-edge" />
            <feBlend in="refracted" in2="red-edge" mode="screen" result="red-blend" />
            <feBlend in="red-blend" in2="blue-edge" mode="screen" />
          </filter>
        </defs>
      </svg>
      <span aria-hidden className="optical-glass__lens" style={lensStyle} />
      <span aria-hidden className="optical-glass__light" />
      <span className="optical-glass__content">{children}</span>
    </button>
  )
}
