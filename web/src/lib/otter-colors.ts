/** Otter 默认渐变（大獭主色） */
export const OTTER_GRADIENT = 'linear-gradient(135deg,#A88260,#6B5638)'

/** Otter 颜色系统 */

export const otterColors: Record<string, { hex: string; gradient: string; nameClass: string; border: string }> = {
  o1: { hex: '#8B6F47', gradient: 'linear-gradient(135deg,#A88260,#6B5638)', nameClass: 'text-otter-600', border: '#8B6F47' },
  o2: { hex: '#4A9B9B', gradient: 'linear-gradient(135deg,#7BC5C5,#3A8B8B)', nameClass: 'text-teal-600', border: '#4A9B9B' },
  o3: { hex: '#D9A57B', gradient: 'linear-gradient(135deg,#E8B98E,#C9956B)', nameClass: 'text-caramel-600', border: '#D9A57B' },
  o4: { hex: '#9B8AC8', gradient: 'linear-gradient(135deg,#B5A8D8,#8B7AB8)', nameClass: 'text-lavender-600', border: '#9B8AC8' },
  o5: { hex: '#C9956B', gradient: 'linear-gradient(135deg,#E8B98E,#C9956B)', nameClass: 'text-caramel-600', border: '#C9956B' },
}

export function getOtterColor(otterId: string, ci?: number) {
  if (otterColors[otterId]) return otterColors[otterId]
  if (ci && ci >= 1 && ci <= 4) return otterColors[`o${ci + 1}`]
  return otterColors.o1
}
