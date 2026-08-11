import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fmtRelativeTime } from './utils'

describe('fmtRelativeTime', () => {
  beforeEach(() => {
    // 固定当前时间为 2026-08-11 15:00:00
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-11T15:00:00'))
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
    expect(fmtRelativeTime('2026-08-11T14:59:30')).toBe('刚刚')
  })

  it('N 分钟前（1-59分钟）', () => {
    expect(fmtRelativeTime('2026-08-11T14:55:00')).toBe('5分钟前')
    expect(fmtRelativeTime('2026-08-11T14:01:00')).toBe('59分钟前')
  })

  it('N 小时前（1-23小时）', () => {
    expect(fmtRelativeTime('2026-08-11T12:00:00')).toBe('3小时前')
    expect(fmtRelativeTime('2026-08-10T16:00:00')).toBe('23小时前')
  })

  it('昨天 HH:mm', () => {
    expect(fmtRelativeTime('2026-08-10T14:30:00')).toBe('昨天 14:30')
  })

  it('更早日期（同年内）显示 MM-DD HH:mm', () => {
    expect(fmtRelativeTime('2026-01-15T10:00:00')).toBe('01-15 10:00')
  })

  it('跨年消息显示 YYYY-MM-DD HH:mm', () => {
    expect(fmtRelativeTime('2025-12-25T09:00:00')).toBe('2025-12-25 09:00')
  })

  it('UTC 时间带 Z 后缀正确处理', () => {
    // UTC 06:00 = 本地 14:00（+8 时区下），距 fake time 15:00 = 1小时
    expect(fmtRelativeTime('2026-08-11T06:00:00Z')).toBe('1小时前')
  })
})
