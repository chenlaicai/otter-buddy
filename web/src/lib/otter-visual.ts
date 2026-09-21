/**
 * F20260921otcl：海獭视觉单一入口（取色 + 取头像）。
 *
 * 语义：视觉是身份的纯函数——identity（type+color）完整时走库值；
 * 缺失时展示回退（type 缺失按 small、color 缺失按 fnv1a(otterId) 落色板），
 * 回退纯展示不落库、不与出生分配主路径竞争。
 *
 * 数据源：SSE 事件（otterType/otterColor）+ participants/entries DTO（senderColor）
 * + LocalOtter.color——四路契约补齐后 identity 处处可得，回退仅承接异常路径
 * （无 conversationId 创建、老数据未回填、事件字段缺席）。
 *
 * 本文件是 getOtterColor/getOtterAvatar 的唯一收敛点：调用方不可能绕过
 * （旧导出已删除，见 otter-colors.ts / otter-avatars.ts）。
 */
import { OTTER_PALETTE_KEYS, OTTER_PALETTE_HEX, BIG_OTTER_HEX, type OtterPaletteKey } from '@contract/api/otter-palette'
import { getOtterAvatar } from './otter-avatars'

/** 视觉令牌（与旧 getOtterColor 返回同形，调用点零适配） */
export interface OtterVisualColor {
  hex: string
  gradient: string
  nameClass: string
  border: string
}

/** 身份入参：type + 色板 key（color 为 null/缺失走展示回退） */
export interface OtterVisualIdentity {
  type?: 'big' | 'small' | string | null
  color?: string | null
}

/** 大獭品牌棕（恒定，不进色板） */
const BIG_OTTER_COLOR: OtterVisualColor = {
  hex: BIG_OTTER_HEX,
  gradient: 'linear-gradient(135deg,#A88260,#6B5638)',
  nameClass: 'text-otter-500',
  border: BIG_OTTER_HEX,
}

/** 色板 key → 视觉令牌（渐变按主色生成双色阶；nameClass 用 tailwind 文字色 token） */
const PALETTE_VISUALS: Record<OtterPaletteKey, OtterVisualColor> = {
  teal: { hex: '#4A9B9B', gradient: 'linear-gradient(135deg,#7BC5C5,#3A8B8B)', nameClass: 'text-teal-600', border: '#4A9B9B' },
  caramel: { hex: '#C9956B', gradient: 'linear-gradient(135deg,#E8B98E,#8F6234)', nameClass: 'text-caramel-600', border: '#C9956B' },
  lavender: { hex: '#9B8AC8', gradient: 'linear-gradient(135deg,#B5A8D8,#6B5A98)', nameClass: 'text-lavender-600', border: '#9B8AC8' },
  rose: { hex: '#C4758D', gradient: 'linear-gradient(135deg,#D899AB,#A05A72)', nameClass: 'text-rose-600', border: '#C4758D' },
  amber: { hex: '#D4A017', gradient: 'linear-gradient(135deg,#E8BC45,#9A7209)', nameClass: 'text-amber-600', border: '#D4A017' },
  sage: { hex: '#8FAF8F', gradient: 'linear-gradient(135deg,#ABC9AB,#6F8F6F)', nameClass: 'text-sage-600', border: '#8FAF8F' },
  slate: { hex: '#7A8B99', gradient: 'linear-gradient(135deg,#97A8B5,#5C6D7B)', nameClass: 'text-slate-600', border: '#7A8B99' },
  plum: { hex: '#9C6B9C', gradient: 'linear-gradient(135deg,#B48AB4,#7A4F7A)', nameClass: 'text-plum-600', border: '#9C6B9C' },
}

/** FNV-1a 32-bit hash：确定性、跨刷新稳定（展示回退专用，与头像 hash 同款算法） */
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 展示回退色：otterId hash 落色板（不落库；同一 id 跨刷新稳定） */
function fallbackColor(otterId: string): OtterVisualColor {
  const key = OTTER_PALETTE_KEYS[fnv1a(otterId) % OTTER_PALETTE_KEYS.length]
  return PALETTE_VISUALS[key]
}

/** key 合法性收口：未知 key（未来色板变更/脏数据）走回退，不炸渲染 */
function visualForKey(color: string | null | undefined, otterId: string): OtterVisualColor {
  if (color && (OTTER_PALETTE_KEYS as readonly string[]).includes(color)) {
    return PALETTE_VISUALS[color as OtterPaletteKey]
  }
  return fallbackColor(otterId)
}

/**
 * 海獭视觉解析单一入口。
 * - type='big' → 品牌棕（恒定；color 不参与）
 * - type='small' + 合法 color key → 色板库值
 * - 其余（type 缺失按 small / color 缺失或非法）→ fnv1a(otterId) 展示回退
 */
export function resolveOtterVisual(
  otterId: string,
  identity?: OtterVisualIdentity | null,
): { color: OtterVisualColor; avatar: string } {
  const type = identity?.type ?? 'small'
  const color: OtterVisualColor = type === 'big'
    ? BIG_OTTER_COLOR
    : visualForKey(identity?.color, otterId)
  return { color, avatar: getOtterAvatar(otterId, type === 'big' ? 'big' : 'small') }
}

/** 色板主色（hex）只读导出（调试/测试用） */
export { OTTER_PALETTE_HEX }
