import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fmtRelativeTime, fmtTimeShort } from './utils'

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

describe('fmtTimeShort', () => {
  it('空字符串返回空字符串', () => {
    expect(fmtTimeShort('')).toBe('')
  })

  it('无效日期返回原字符串', () => {
    expect(fmtTimeShort('invalid-date')).toBe('invalid-date')
  })

  it('正常时间戳格式化为 MM-DD HH:mm', () => {
    // 使用本地时区验证——构造已知时间戳
    const ts = '2026-09-20T06:30:00Z'
    const d = new Date(ts)
    const expected = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    expect(fmtTimeShort(ts)).toBe(expected)
  })

  it('跨年日期保留 MM-DD 格式', () => {
    const ts = '2025-12-31T23:59:00Z'
    const d = new Date(ts)
    const expected = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    expect(fmtTimeShort(ts)).toBe(expected)
  })

  it('UTC 时间不被误当本地时间（A1/A2 根因验证）', () => {
    // CST 0:00-8:00 期间，UTC 日期会比本地日期早一天
    // 例：UTC 2026-09-19T20:00:00Z = CST 2026-09-20 04:00
    // 旧 toISOString().slice(5,10) 会返回 09-19，本地格式化应返回 09-20
    // 注：断言用本地 Date 的 get*() 构造期望值，与 fmtTimeShort 同源——本用例锁定的是
    // 「不走 UTC 切片」这条路径（旧实现返回 UTC 日期，本地时区非 UTC 时必不相等）
    const utcMidnight = '2026-09-20T00:00:00Z' // UTC 0 点 = CST 8 点
    const d = new Date(utcMidnight)
    const result = fmtTimeShort(utcMidnight)
    // 本地时区下应显示本地日期
    expect(result).toContain(`${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
  })

  it('跨日边界：UTC 23:59 与次日 00:01 的标签不同（A1 泳道轴验证）', () => {
    // A1 修复场景：SwimlaneTimeline 轴标签在 UTC 日期切换点附近必须能区分日期。
    // 用本地时区锚定期望值（与实现同源，但跨日断言在非 UTC 时区下与旧 UTC 切片实现必不相等）
    const day1 = new Date('2026-09-19T15:00:00Z') // CST 9-19 23:00
    const day2 = new Date('2026-09-19T16:00:00Z') // CST 9-20 00:00（跨日）
    const label1 = fmtTimeShort(day1.toISOString()).slice(0, 5)
    const label2 = fmtTimeShort(day2.toISOString()).slice(0, 5)
    expect(label1).not.toBe(label2)
    expect(label1).toBe(`${pad(day1.getMonth() + 1)}-${pad(day1.getDate())}`)
    expect(label2).toBe(`${pad(day2.getMonth() + 1)}-${pad(day2.getDate())}`)
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
