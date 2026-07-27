/** Otter 默认渐变（大獭主色） */
export const OTTER_GRADIENT = 'linear-gradient(135deg,#A88260,#6B5638)'

/** 大獭固定颜色 */
const BIG_OTTER_COLOR = { hex: '#8B6F47', gradient: 'linear-gradient(135deg,#A88260,#6B5638)', nameClass: 'text-otter-600', border: '#8B6F47' }

/** 小獭颜色池（动态分配） */
const SMALL_OTTER_COLORS = [
  { hex: '#4A9B9B', gradient: 'linear-gradient(135deg,#7BC5C5,#3A8B8B)', nameClass: 'text-teal-600', border: '#4A9B9B' },
  { hex: '#D9A57B', gradient: 'linear-gradient(135deg,#E8B98E,#C9956B)', nameClass: 'text-caramel-600', border: '#D9A57B' },
  { hex: '#9B8AC8', gradient: 'linear-gradient(135deg,#B5A8D8,#8B7AB8)', nameClass: 'text-lavender-600', border: '#9B8AC8' },
  { hex: '#C9956B', gradient: 'linear-gradient(135deg,#E8B98E,#C9956B)', nameClass: 'text-caramel-600', border: '#C9956B' },
  { hex: '#6B8E8E', gradient: 'linear-gradient(135deg,#8FB8B8,#5A7E7E)', nameClass: 'text-teal-600', border: '#6B8E8E' },
  { hex: '#B8860B', gradient: 'linear-gradient(135deg,#D4A017,#9A7209)', nameClass: 'text-caramel-600', border: '#B8860B' },
  { hex: '#7B68AE', gradient: 'linear-gradient(135deg,#9B88CE,#6B589E)', nameClass: 'text-lavender-600', border: '#7B68AE' },
  { hex: '#CD853F', gradient: 'linear-gradient(135deg,#E8A05E,#B27535)', nameClass: 'text-caramel-600', border: '#CD853F' },
]

/** 小獭颜色分配缓存 */
const smallOtterColorMap = new Map<string, typeof SMALL_OTTER_COLORS[0]>()
let nextColorIndex = 0

/** Otter 颜色系统 */
export const otterColors: Record<string, { hex: string; gradient: string; nameClass: string; border: string }> = {
  o1: BIG_OTTER_COLOR,
}

export function getOtterColor(otterId: string, ci?: number) {
  // 大獭固定颜色
  if (otterId === 'o1' || otterId === 'big-otter') return BIG_OTTER_COLOR

  // 小獭动态分配颜色
  if (!smallOtterColorMap.has(otterId)) {
    const color = SMALL_OTTER_COLORS[nextColorIndex % SMALL_OTTER_COLORS.length]
    smallOtterColorMap.set(otterId, color)
    nextColorIndex++
  }
  return smallOtterColorMap.get(otterId)!
}
