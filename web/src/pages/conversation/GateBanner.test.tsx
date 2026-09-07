// @vitest-environment jsdom
/**
 * S3.5 交互投影测试（F20260903s35u）：
 * - GateBanner 两种态文案与优先级（用户停机 > 限流冷却）
 *
 * F20260907rmst：信号轨迹 chip 移除后，trailStateMeta/humanizeNote 用例随
 * signal-trail.ts 一并退役（chip 已删，库无消费方）。
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { GateBanner, gateBannerMeta } from './GateBanner'

describe('gateBannerMeta（横幅两态与优先级）', () => {
  it('halted 优先于 rateLimited（用户意志 > 系统推导）', () => {
    const meta = gateBannerMeta({ halted: true, rateLimitedUntil: '2026-09-03T12:00:00Z' })
    expect(meta!.icon).toBe('🛑')
    expect(meta!.text).toContain('已停机')
    expect(meta!.text).toContain('发新消息即恢复')
  })
  it('仅熔断：显示冷却截止时间与排队说明', () => {
    const meta = gateBannerMeta({ halted: false, rateLimitedUntil: '2026-09-03T14:45:00Z' })
    expect(meta!.icon).toBe('⏳')
    expect(meta!.text).toContain('限流冷却')
    expect(meta!.text).toContain('自动恢复')
  })
  it('无闸门 → null（横幅不渲染）', () => {
    expect(gateBannerMeta(null)).toBeNull()
    expect(gateBannerMeta({ halted: false, rateLimitedUntil: null })).toBeNull()
    expect(gateBannerMeta(undefined)).toBeNull()
  })
  it('GateBanner 渲染：gate=null 时不输出 DOM', () => {
    const { container } = render(<GateBanner gate={null} />)
    expect(container.querySelector('[data-testid="gate-banner"]')).toBeNull()
  })
  it('GateBanner 渲染：halted 时输出横幅', () => {
    render(<GateBanner gate={{ halted: true, rateLimitedUntil: null }} />)
    expect(screen.getByTestId('gate-banner')).toBeDefined()
    expect(screen.getByTestId('gate-banner').textContent).toContain('已停机')
  })
})
