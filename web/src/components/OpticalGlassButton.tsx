import { type ButtonHTMLAttributes, type CSSProperties } from 'react'
import { OpticalGlassLayers } from './LensFilter'

interface OpticalGlassButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  width: number
  height: number
  radius: number
  shape?: 'circle' | 'squircle'
}

/**
 * F20261103lglct：小交互面的光学玻璃——折射源是静态画布，不采样消息流。
 * 内容层在滤镜之外，图标/文字不被折射，也不参与纹理计算。
 */
export function OpticalGlassButton({
  width, height, radius, shape = 'circle', className = '', style, children,
  type = 'button', ...buttonProps
}: OpticalGlassButtonProps) {
  const glassStyle = { ...style, width, height, '--glass-radius': `${radius}px` } as CSSProperties
  return (
    <button {...buttonProps} type={type} className={`optical-glass ${className}`} style={glassStyle} data-optical-glass={shape}>
      <OpticalGlassLayers width={width} height={height} shape={shape} contentClassName="optical-glass__content">{children}</OpticalGlassLayers>
    </button>
  )
}
