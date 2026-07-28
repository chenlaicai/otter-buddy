import { getOtterColor } from '../lib/otter-colors'

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
  const initial = name.charAt(0)

  return (
    <div
      className="rounded-full flex items-center justify-center font-bold text-white shadow-bubble flex-shrink-0"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.375,
        background: color.gradient,
      }}
    >
      {initial}
    </div>
  )
}
