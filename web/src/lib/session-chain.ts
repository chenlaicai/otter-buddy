import type { LocalOtterSession } from './mappers'

/**
 * F20260805rsto：按 previousSessionId 拉链排序（首世在前），链外残留按时间附加。
 * 「第 N 世」计数口径 = session 在拉链结果中的位置（F20260805dmux 统一右栏卡片与详情弹窗，
 * 避免竞态残留/多分支场景下右栏 sessions.length 与弹窗拉链 index 对不上）。
 */
export function sortSessionChain(sessions: LocalOtterSession[]): LocalOtterSession[] {
  const byPrev = new Map(sessions.map(s => [s.previousSessionId, s] as const))
  const ordered: LocalOtterSession[] = []
  let cur = byPrev.get(null)
  while (cur) { ordered.push(cur); cur = byPrev.get(cur.id) }
  for (const s of sessions) if (!ordered.includes(s)) ordered.push(s)
  return ordered
}
