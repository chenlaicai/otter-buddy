import type { LocalOtterSession } from './mappers'

/**
 * F20260805rsto：按 previousSessionId 拉链排序（首世在前）。
 * 链外残留（竞态双头/多分支等）按输入数组序附于链尾——当前端拉取为 started_at DESC，
 * 即残留项新的在前，其「位置」不代表代际早晚。
 * 「第 N 世」计数口径 = session 在拉链结果中的位置（F20260805dmux 统一右栏卡片与详情弹窗，
 * 避免竞态残留/多分支场景下右栏 sessions.length 与弹窗拉链 index 对不上）。
 */
export function sortSessionChain(sessions: LocalOtterSession[]): LocalOtterSession[] {
  /** ?? null 归一化：防未来某序列化路径把 previousSessionId undefined 化导致首世静默丢失 */
  const byPrev = new Map(sessions.map(s => [s.previousSessionId ?? null, s] as const))
  const ordered: LocalOtterSession[] = []
  let cur = byPrev.get(null)
  while (cur) { ordered.push(cur); cur = byPrev.get(cur.id) }
  for (const s of sessions) if (!ordered.includes(s)) ordered.push(s)
  return ordered
}
