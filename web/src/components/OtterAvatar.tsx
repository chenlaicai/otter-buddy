import { getOtterColor } from '../lib/otter-colors'
import { getOtterAvatar } from '../lib/otter-avatars'

/** Otter avatar with color tag (← D-UI-1: multi-otter color differentiation) */
export function OtterAvatar({
  otterId,
  name,
  size = 32,
}: {
  otterId: string
  name: string
  size?: number
}) {
  const color = getOtterColor(otterId)
  const avatar = getOtterAvatar(otterId)

  return (
    <img
      src={avatar}
      alt={name}
      width={size}
      height={size}
      className="rounded-full flex-shrink-0 shadow-bubble object-cover"
      style={{ width: size, height: size, border: `2px solid ${color.border}` }}
    />
  )
}
