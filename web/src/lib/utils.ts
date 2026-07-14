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
