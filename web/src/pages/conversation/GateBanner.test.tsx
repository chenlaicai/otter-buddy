// @vitest-environment jsdom
/**
 * S3.5 交互投影测试（F20260903s35u）：
 * - GateBanner 两种态文案与优先级（用户停机 > 限流冷却）
 * - trailStateMeta 弱化模式（正常流转只图标，FAILED/高优豁免）
 * - G7 黑话映射（note 人话化）
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { GateBanner, gateBannerMeta } from './GateBanner'
import { trailStateMeta, humanizeNote } from '../../lib/signal-trail'

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

describe('trailStateMeta 弱化模式（G8/A 方案：正常流转静默，异常醒目）', () => {
  it('quiet=true：正常态只出图标（label=icon）', () => {
    expect(trailStateMeta('PENDING', 'NORMAL', null, true).label).toBe('⏳')
    expect(trailStateMeta('CONSUMING', 'NORMAL', null, true).label).toBe('⚡')
    expect(trailStateMeta('CONSUMED', 'NORMAL', null, true).label).toBe('✓')
  })
  it('quiet=true：FAILED 与 URGENT/HALT 豁免弱化（保持文字）', () => {
    expect(trailStateMeta('FAILED', 'NORMAL', null, true).label).toBe('❌')
    expect(trailStateMeta('PENDING', 'URGENT', null, true).label).toBe('排队待消化')
    expect(trailStateMeta('PENDING', 'HALT', null, true).label).toBe('排队待消化')
  })
  it('quiet=false（详情行）：全文字不弱化', () => {
    expect(trailStateMeta('PENDING', 'NORMAL', null, false).label).toBe('排队待消化')
    expect(trailStateMeta('CONSUMED', 'NORMAL', null).label).toBe('已处理')
  })
})

describe('humanizeNote（G7 黑话映射）', () => {
  it('死亡证明 note → 人话', () => {
    expect(humanizeNote('进程重启，派发中断（sgp2 死亡证明）')).toBe('服务重启时被打断')
  })
  it('router catch → 自动处理失败', () => {
    const out = humanizeNote('router catch: No session or config found')
    expect(out).toContain('自动处理失败')
    expect(out).toContain('No session or config found')
    expect(out).not.toContain('router catch:')
  })
  it('retry 前情链只取本轮原因（分号前）', () => {
    expect(humanizeNote('boom 2')).toBe('boom 2')
  })
  it('null/空 → null', () => {
    expect(humanizeNote(null)).toBeNull()
    expect(humanizeNote('')).toBeNull()
  })
})
