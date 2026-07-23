/** Utility functions for formatting and helpers */

export function fmtTokens(t: number): string {
  return t < 1000 ? `${t} tokens` : `${(t / 1000).toFixed(1)}k`
}

export function ctxPercent(tokens: number, max: number): number {
  return Math.min(100, (tokens / max) * 100)
}

export function nowTs(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

/** 格式化时间为 yyyy-MM-dd HH:mm:ss（本地时区） */
export function fmtTime(ts: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
