import { useState } from 'react'
import { getOtterColor } from '../lib/otter-colors'
import { getOtterAvatar } from '../lib/otter-avatars'

/**
 * Otter avatar with color tag (← D-UI-1: multi-otter color differentiation)
 * 像素风 SVG 头像；加载失败时降级为首字母渐变圆（检视发现 3 的兜底路径）。
 * type 优先于 ID 判断大獭身份（生产 otterId 为 UUID，见 otter-avatars.ts）。
 */
export function OtterAvatar({
  otterId,
  name,
  size = 32,
  type,
}: {
  otterId: string
  name: string
  size?: number
  type?: 'big' | 'small'
}) {
  const [failed, setFailed] = useState(false)
  const color = getOtterColor(otterId, type)
  const avatar = getOtterAvatar(otterId, type)
  const initial = name.charAt(0)

  if (failed) {
    return (
      <div
        className="rounded-full flex items-center justify-center font-bold text-white shadow-bubble flex-shrink-0"
        style={{
          width: size,
          height: size,
          fontSize: size * 0.375,
          background: color.gradient,
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
      style={{ width: size, height: size, border: `2px solid ${color.border}` }}
    />
  )
}
