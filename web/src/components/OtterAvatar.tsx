import { getOtterColor } from '../mock/data'

/** Otter avatar with color tag (← D-UI-1: multi-otter color differentiation) */
export function OtterAvatar({
  otterId,
  name,
  ci,
  size = 32,
}: {
  otterId: string
  name: string
  ci?: number
  size?: number
}) {
  const color = getOtterColor(otterId, ci)
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
