import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fmtRelativeTime } from './utils'

describe('fmtRelativeTime', () => {
  beforeEach(() => {
    // 固定当前时间为 2026-08-11 15:00:00+08:00（UTC 07:00）
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-11T07:00:00Z'))
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
    // 2026-08-10 14:30+08:00 = 2026-08-10 06:30Z
    expect(fmtRelativeTime('2026-08-10T06:30:00Z')).toBe('昨天 14:30')
  })

  it('更早日期（同年内）显示 MM-DD HH:mm', () => {
    expect(fmtRelativeTime('2026-01-15T02:00:00Z')).toBe('01-15 10:00')
  })

  it('跨年消息显示 YYYY-MM-DD HH:mm', () => {
    expect(fmtRelativeTime('2025-12-25T01:00:00Z')).toBe('2025-12-25 09:00')
  })
})
