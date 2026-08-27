/**
 * Otter 头像分配系统
 *
 * 分配规则：
 * - 大獭（type='big'，或已知历史大獭 ID）→ datu.svg 固定
 * - 用户 → user.svg 固定
 * - 小獭 → 九款像素风随机池，按 otterId 确定性 hash 分配
 *   （同一 otterId 每次刷新得到同一头像，体验是"随机归宿"但稳定）
 * - 用户显式自选的头像存 localStorage override（F20260827ucrt），
 *   优先于 hash 池；「随机」= 清除 override 回 hash 池。
 *   局限：localStorage 是 per-browser 的，换设备/清缓存回 hash 池（单用户本地系统可接受，
 *   跨设备持久化见 issue #515）
 *
 * 注意：生产环境 otterId 为 UUID，判断大獭必须优先用 otter.type
 * （检视发现 2：BIG_OTTER_IDS 硬编码 ID 仅作历史数据兜底）。
 */

/** 大獭固定头像 */
const BIG_OTTER_AVATAR = '/avatars/datu.svg'

/** 用户固定头像 */
export const USER_AVATAR = '/avatars/user.svg'

/** 小獭九款随机池（按意象命名，与 web/public/avatars/ 下文件对应）
 *  F20260827ucrt：导出供创建弹窗九宫格渲染（只读消费，不修改池内容） */
export const SMALL_OTTER_POOL = [
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

/** 池内资源名 → 展示 URL（与 getOtterAvatar 同一拼接规则） */
export function smallOtterAvatarUrl(resourceName: string): string {
  return `/avatars/${resourceName}.svg`
}

/** localStorage override key 前缀（导出便于调试/清缓存定位） */
export const OTTER_AVATAR_OVERRIDE_PREFIX = 'otter-avatar:'

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
 * 读取小獭头像 override（仅小獭池内资源名有效；异常环境返回 null 走 hash 池）。
 * 用户自选（F20260827ucrt）；大獭/用户头像不受 override 影响
 */
function getAvatarOverride(otterId: string, type?: 'big' | 'small'): string | null {
  if (type === 'big') return null
  try {
    const v = localStorage.getItem(OTTER_AVATAR_OVERRIDE_PREFIX + otterId)
    return v && (SMALL_OTTER_POOL as readonly string[]).includes(v) ? v : null
  } catch {
    return null // SSR/隐私模式等 localStorage 不可用场景
  }
}

/**
 * 写入/清除小獭头像 override（F20260827ucrt UI 自选）。
 * @param avatarName 池内资源名；null = 清除（回「随机」hash 池）
 */
export function setOtterAvatarOverride(otterId: string, avatarName: string | null): void {
  try {
    if (avatarName === null) {
      localStorage.removeItem(OTTER_AVATAR_OVERRIDE_PREFIX + otterId)
    } else if ((SMALL_OTTER_POOL as readonly string[]).includes(avatarName)) {
      localStorage.setItem(OTTER_AVATAR_OVERRIDE_PREFIX + otterId, avatarName)
    }
  } catch {
    // localStorage 不可用（隐私模式等）时静默降级——头像回 hash 池，不阻断创建流程
  }
}

/**
 * otterId → 头像 URL。
 * 优先按 otter.type 判断大獭（生产 ID 为 UUID，无法枚举硬编码）；
 * type 缺省时回退历史 ID 池（o1/big-otter），再缺省视为小獭。
 * 小獭优先读 localStorage override（F20260827ucrt），未命中走 hash 池——
 * 未自选的獭路径与改前逐位一致。
 */
export function getOtterAvatar(otterId: string, type?: 'big' | 'small'): string {
  if (type === 'big' || (!type && BIG_OTTER_IDS.has(otterId))) return BIG_OTTER_AVATAR
  const override = getAvatarOverride(otterId, type)
  if (override) return `/avatars/${override}.svg`
  const poolIndex = fnv1a(otterId) % SMALL_OTTER_POOL.length
  return `/avatars/${SMALL_OTTER_POOL[poolIndex]}.svg`
}

/** 用户头像（固定） */
export function getUserAvatar(): string {
  return USER_AVATAR
}
