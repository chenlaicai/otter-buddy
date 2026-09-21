import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fmtRelativeTime, fmtTimeShort } from './utils'

const pad = (n: number) => String(n).padStart(2, '0')

/** 强制进程时区（同步窗口内立即恢复）——CI runner 是 UTC，本地时区=UTC 时新旧实现行为相同、
 * 回归防线尖区分力；强制 CST 后旧实现（UTC 切片）在任何 runner 上都会被排中 */
function withTZ(tz: string, fn: () => void): void {
  const saved = process.env.TZ
  process.env.TZ = tz
  try {
    fn()
  } finally {
    if (saved === undefined) delete process.env.TZ
    else process.env.TZ = saved
  }
}
function localDisplay(ts: string): { hhmm: string; date: string; yearDate: string } {
  const d = new Date(ts)
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return {
    hhmm,
    date: `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`,
    yearDate: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`,
  }
}

describe('fmtTimeShort', () => {
  it('空字符串返回空字符串', () => {
    expect(fmtTimeShort('')).toBe('')
  })

  it('无效日期返回原字符串', () => {
    expect(fmtTimeShort('invalid-date')).toBe('invalid-date')
  })

  it('正常时间戳格式化为 MM-DD HH:mm', () => {
    withTZ('Asia/Shanghai', () => {
      expect(fmtTimeShort('2026-09-20T06:30:00Z')).toBe('09-20 14:30')
    })
  })

  it('跨年跨日：UTC 12-31 23:59 = CST 次年 01-01 07:59', () => {
    withTZ('Asia/Shanghai', () => {
      expect(fmtTimeShort('2025-12-31T23:59:00Z')).toBe('01-01 07:59')
    })
  })

  it('UTC 时间不被误当本地时间（A1/A2 根因验证）', () => {
    // CST 0:00-8:00 窗口：UTC 9-19 20:00 = CST 9-20 04:00（凌晨）。
    // 旧实现 toISOString().slice(5,10) 返回 "09-19"（UTC 日期，前一天）——强制 CST 后
    // 本用例在任何 runner（含 UTC CI）上对旧实现都是红的，回归防线成立
    withTZ('Asia/Shanghai', () => {
      expect(fmtTimeShort('2026-09-19T20:00:00Z')).toBe('09-20 04:00')
    })
  })

  it('跨日边界：凌晨相邻两时刻分属两日，标签必不同（A1 泳道轴验证）', () => {
    withTZ('Asia/Shanghai', () => {
      const label1 = fmtTimeShort('2026-09-19T15:00:00Z').slice(0, 5) // CST 9-19 23:00
      const label2 = fmtTimeShort('2026-09-19T16:00:00Z').slice(0, 5) // CST 9-20 00:00（跨日）
      expect(label1).toBe('09-19')
      expect(label2).toBe('09-20')
      expect(label1).not.toBe(label2)
    })
  })
})

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
