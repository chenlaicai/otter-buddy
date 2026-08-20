/** Utility functions for formatting and helpers */

export function fmtTokens(t: number): string {
  return t < 1000 ? `${t} tokens` : `${(t / 1000).toFixed(1)}k`
}

export function ctxPercent(tokens: number, max: number): number {
  return Math.min(100, (tokens / max) * 100)
}

export function nowTs(): string {
  return new Date().toISOString()
}

/** 格式化时间为 yyyy-MM-dd HH:mm:ss（本地时区） */
export function fmtTime(ts: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 格式化为相对时间（如"刚刚"、"5分钟前"、"昨天 14:30"） */
export function fmtRelativeTime(ts: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)

  // 未来时间：显示绝对时间（生产环境不会出现，防御性处理）
  if (diffSec < 0) return fmtTime(ts)
  if (diffSec < 60) return '刚刚'
  if (diffMin < 60) return `${diffMin}分钟前`
  if (diffHour < 24) return `${diffHour}小时前`

  const pad = (n: number) => String(n).padStart(2, '0')
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`

  // 昨天
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm}`

  // 更早：显示日期（跨年显示年份）
  if (d.getFullYear() !== now.getFullYear()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`
  }
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`
}
