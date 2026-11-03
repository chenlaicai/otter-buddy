import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { OpticalGlassLayers } from './LensFilter'

/** F20261103lglct：独立对话玻璃块；仅在列表自身尺寸变化时测布局，不看消息流。 */
export function OpticalGlassItem({ radius = 14, children, className = '', ...props }: {
  radius?: number
  children: ReactNode
} & HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 208, height: 64 })
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => {
      const rect = element.getBoundingClientRect()
      setSize({ width: Math.round(rect.width), height: Math.round(rect.height) })
    }
    update()
    // 只观察条目尺寸，不观察内容或消息 DOM；流式文本更新不会触发滤镜更新。
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div {...props} ref={ref} className={`optical-glass optical-glass--item ${className}`} style={{ ...props.style, '--glass-radius': `${radius}px` } as React.CSSProperties}>
      <OpticalGlassLayers width={size.width} height={size.height} shape="squircle" strength={0.3} contentClassName="optical-glass__item-content">{children}</OpticalGlassLayers>
    </div>
  )
}
