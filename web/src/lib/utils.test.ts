import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fmtRelativeTime } from './utils'

const pad = (n: number) => String(n).padStart(2, '0')
function localDisplay(ts: string): { hhmm: string; date: string; yearDate: string } {
  const d = new Date(ts)
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return {
    hhmm,
    date: `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`,
    yearDate: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`,
  }
}

describe('fmtRelativeTime', () => {
  // 固定为 UTC 2026-08-11 07:00:00（各时区本地时间不同，但 diff 计算一致）
  const NOW = '2026-08-11T07:00:00Z'

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('空字符串返回空字符串', () => {
    expect(fmtRelativeTime('')).toBe('')
  })

  it('无效日期返回原字符串', () => {
    expect(fmtRelativeTime('invalid-date')).toBe('invalid-date')
  })

  it('刚刚（< 60秒）', () => {
    expect(fmtRelativeTime('2026-08-11T06:59:30Z')).toBe('刚刚')
  })

  it('N 分钟前（1-59分钟）', () => {
    expect(fmtRelativeTime('2026-08-11T06:55:00Z')).toBe('5分钟前')
    expect(fmtRelativeTime('2026-08-11T06:01:00Z')).toBe('59分钟前')
  })

  it('N 小时前（1-23小时）', () => {
    expect(fmtRelativeTime('2026-08-11T04:00:00Z')).toBe('3小时前')
    expect(fmtRelativeTime('2026-08-10T08:00:00Z')).toBe('23小时前')
  })

  it('昨天 HH:mm', () => {
    const ts = '2026-08-10T06:30:00Z' // 无论哪个时区，距 NOW 超 24h 但还是"昨天"
    const { hhmm } = localDisplay(ts)
    expect(fmtRelativeTime(ts)).toBe(`昨天 ${hhmm}`)
  })

  it('更早日期（同年内）显示 MM-DD HH:mm', () => {
    const ts = '2026-01-15T02:00:00Z'
    const { date } = localDisplay(ts)
    expect(fmtRelativeTime(ts)).toBe(date)
  })

  it('跨年消息显示 YYYY-MM-DD HH:mm', () => {
    const ts = '2025-12-25T01:00:00Z'
    const { yearDate } = localDisplay(ts)
    expect(fmtRelativeTime(ts)).toBe(yearDate)
  })

  it('未来时间显示绝对时间（防御性处理）', () => {
    // 未来时间（负 diff）应显示绝对时间而非'刚刚'
    const ts = '2026-08-11T08:00:00Z' // 1小时后
    expect(fmtRelativeTime(ts)).not.toBe('刚刚')
    // 应该显示绝对时间格式
    const d = new Date(ts)
    const pad = (n: number) => String(n).padStart(2, '0')
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    expect(fmtRelativeTime(ts)).toBe(expected)
  })
})
