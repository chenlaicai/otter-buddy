/**
 * F20260921otcl：海獭色板（前后端共享的运行时契约值）。
 *
 * 单一事实源：key 集合与顺序是「出生挑色」「迁移回填」「>8 獭 tie-breaking（并列取
 * 数组 index 最小）」的共同依据——双端漂移会造成后端挑的色前端画不出，故落
 * api-contract（value 导出准入：前后端双方消费的运行时契约值）。
 *
 * - 后端消费 key 集合（CreateOtter 挑色校验、存量回填迁移）
 * - 前端消费 key→hex/gradient/nameClass（resolveOtterVisual 的样式映射）
 * - 色值按现有设计 token 就近取（teal/caramel/lavender 系 globals.css @theme，
 *   sage/slate/plum 为新增 token 阶）；大獭不进池（type 判定恒品牌棕）
 */

/** 色板 key（8 个去重色相——旧池 8 项仅 5 色相，重复项已并） */
export type OtterPaletteKey =
  | 'teal'
  | 'caramel'
  | 'lavender'
  | 'rose'
  | 'amber'
  | 'sage'
  | 'slate'
  | 'plum'

/** 色板 key 列表（顺序即优先级：挑「第一个未占用」与「并列取 index 最小」都锚定此顺序） */
export const OTTER_PALETTE_KEYS: readonly OtterPaletteKey[] = [
  'teal',
  'caramel',
  'lavender',
  'rose',
  'amber',
  'sage',
  'slate',
  'plum',
] as const;

/** key → 色值（hex 主色，供后端校验无效 key 与前端展示兜底） */
export const OTTER_PALETTE_HEX: Readonly<Record<OtterPaletteKey, string>> = {
  teal: '#4A9B9B',      // teal-400（既有 token）
  caramel: '#C9956B',   // caramel-500（既有 token）
  lavender: '#9B8AC8',  // lavender-400（既有 token）
  rose: '#C4758D',      // 新增阶（rose 系）
  amber: '#D4A017',     // 旧池 amber 色值保留
  sage: '#8FAF8F',      // 新增阶（sage 系）
  slate: '#7A8B99',     // 新增阶（slate 系）
  plum: '#9C6B9C',      // 新增阶（plum 系）
};

/** 大獭品牌棕（不进色板；type='big' 恒此色） */
export const BIG_OTTER_HEX = '#8B6F47'; // otter-500

/** key 是否为合法色板 key（后端挑色/回填写库前的校验） */
export function isOtterPaletteKey(v: unknown): v is OtterPaletteKey {
  return typeof v === 'string' && (OTTER_PALETTE_KEYS as readonly string[]).includes(v);
}
