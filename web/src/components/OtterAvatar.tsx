import { useState } from 'react'
import { resolveOtterVisual } from '../lib/otter-visual'

/**
 * Otter avatar with color tag (← D-UI-1: multi-otter color differentiation)
 * 像素风 SVG 头像；加载失败时降级为首字母渐变圆（检视发现 3 的兜底路径）。
 * F20260921otcl：视觉解析收敛——内部改调 resolveOtterVisual 单一入口；
 * 签名增加可选 color prop（父组件持有库色——消息事件色/otters 列表色——时传入，
 * 不传时按 type + fnv1a 展示回退兜底）。既有调用方零强制改动（可选 prop 向后兼容）。
 */
export function OtterAvatar({
  otterId,
  name,
  size = 36,
  type,
  color,
}: {
  otterId: string
  name: string
  size?: number
  type?: 'big' | 'small'
  /** F20260921otcl：父组件持有的出生色（色板 key）；优先于内部回退 */
  color?: string | null
}) {
  const [failed, setFailed] = useState(false)
  const visual = resolveOtterVisual(otterId, { type, color })
  const avatar = visual.avatar
  const initial = name.charAt(0)

  if (failed) {
    return (
      <div
        className="rounded-full flex items-center justify-center font-bold text-white shadow-bubble flex-shrink-0"
        style={{
          width: size,
          height: size,
          fontSize: size * 0.375,
          background: visual.color.gradient,
        }}
        aria-label={name}
      >
        {initial}
      </div>
    )
  }

  return (
    <img
      src={avatar}
      alt={name}
      width={size}
      height={size}
      onError={() => setFailed(true)}
      className="rounded-full flex-shrink-0 shadow-bubble object-cover"
      style={{ width: size, height: size, border: `2px solid ${visual.color.border}` }}
    />
  )
}
