/**
 * Otter 头像分配系统
 *
 * 分配规则：
 * - 大獭（type='big'，或已知历史大獭 ID）→ datu.svg 固定
 * - 用户 → user.svg 固定
 * - 小獭 → 九款像素风随机池，按 otterId 确定性 hash 分配
 *   （同一 otterId 每次刷新得到同一头像，体验是"随机归宿"但稳定）
 *
 * 注意：生产环境 otterId 为 UUID，判断大獭必须优先用 otter.type
 * （检视发现 2：BIG_OTTER_IDS 硬编码 ID 仅作历史数据兜底）。
 */

/** 大獭固定头像 */
const BIG_OTTER_AVATAR = '/avatars/datu.svg'

/** 用户固定头像 */
export const USER_AVATAR = '/avatars/user.svg'

/** 小獭九款随机池（按意象命名，与 web/public/avatars/ 下文件对应） */
const SMALL_OTTER_POOL = [
  'otter-01-yu', // 獭祭鱼
  'otter-02-zhuli', // 竹笠
  'otter-03-zhujie', // 朱结
  'otter-04-mianyue', // 眠月
  'otter-05-baobei', // 抱贝
  'otter-06-xianzhu', // 衔竹
  'otter-07-mohen', // 墨痕
  'otter-08-lianye', // 莲叶
  'otter-09-hulu', // 葫芦
] as const

/** 历史大獭 ID 兜底（otter.type 不可得时的降级判断；生产大獭 ID 是 UUID） */
const BIG_OTTER_IDS = new Set(['o1', 'big-otter'])

/** FNV-1a 32-bit hash：确定性、跨刷新稳定 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * otterId → 头像 URL。
 * 优先按 otter.type 判断大獭（生产 ID 为 UUID，无法枚举硬编码）；
 * type 缺省时回退历史 ID 池（o1/big-otter），再缺省视为小獭。
 */
export function getOtterAvatar(otterId: string, type?: 'big' | 'small'): string {
  if (type === 'big' || (!type && BIG_OTTER_IDS.has(otterId))) return BIG_OTTER_AVATAR
  const poolIndex = fnv1a(otterId) % SMALL_OTTER_POOL.length
  return `/avatars/${SMALL_OTTER_POOL[poolIndex]}.svg`
}

/** 用户头像（固定） */
export function getUserAvatar(): string {
  return USER_AVATAR
}
