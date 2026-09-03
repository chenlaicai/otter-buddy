// @vitest-environment jsdom
/**
 * signal-trail 纯函数测试（F20260902u5tr → sgp2 S1b 四态）：信号判据 + 状态盒措辞约束。
 * 措辞约束是 #695 裁决固化项——回归守护：
 * - PENDING 只说「排队待消化」，禁止出现「正在忙」
 * - 不显示队列位置
 * - FAILED 显「处理失败」+ note（失败可见 = S1b 验收③）
 */
import { describe, it, expect } from 'vitest'
import { isSignalMessage, trailStateMeta, trailLevelMeta, type TrailItem } from './signal-trail'
import type { LocalMessage } from './mappers'

function msg(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id: 'm1', st: 'user', si: 'user', content: 'hello',
    status: 'completed', ts: '2026-01-01T00:00:00Z', dur: null,
    ...overrides,
  }
}

describe('isSignalMessage', () => {
  it('completed + user + 投石给 otter = 信号', () => {
    expect(isSignalMessage(msg({ tsp: ['otter-1'] }))).toBe(true)
  })
  it('投石给 user / 空目标 / streaming / system 均非信号', () => {
    expect(isSignalMessage(msg({ tsp: ['user'] }))).toBe(false)
    expect(isSignalMessage(msg({ tsp: [] }))).toBe(false)
    expect(isSignalMessage(msg({ tsp: undefined }))).toBe(false)
    expect(isSignalMessage(msg({ tsp: ['otter-1'], status: 'streaming' }))).toBe(false)
    expect(isSignalMessage(msg({ st: 'system', si: 'sys', tsp: ['otter-1'] }))).toBe(false)
  })
  it('otter self-yield 是信号（收件箱待办）', () => {
    expect(isSignalMessage(msg({ st: 'otter', si: 'o1', tsp: ['o1'] }))).toBe(true)
  })
})

describe('trailStateMeta 措辞约束', () => {
  const cases: Array<[TrailItem['state'], string]> = [
    ['PENDING', 'NORMAL'], ['CONSUMING', 'NORMAL'], ['CONSUMED', 'NORMAL'], ['FAILED', 'NORMAL'],
    ['PENDING', 'URGENT'], ['PENDING', 'HALT'],
  ]
  it.each(cases)('state=%s level=%s 不出现「正在忙」', (state, level) => {
    const meta = trailStateMeta(state, level)
    expect(meta.label).not.toContain('正在忙')
    expect(meta.label).not.toContain('忙碌')
  })
  it('PENDING = 排队待消化（NORMAL 琥珀 / URGENT-HALT 红色升级）', () => {
    expect(trailStateMeta('PENDING', 'NORMAL').label).toBe('排队待消化')
    expect(trailStateMeta('PENDING', 'URGENT').cls).toContain('red')
    expect(trailStateMeta('PENDING', 'HALT').cls).toContain('red')
    expect(trailStateMeta('PENDING', 'NORMAL').cls).toContain('amber')
  })
  it('CONSUMED = 已处理；CONSUMING = 处理中；FAILED = 处理失败（note 人话入 title）', () => {
    expect(trailStateMeta('CONSUMED', 'NORMAL').label).toBe('已处理')
    expect(trailStateMeta('CONSUMING', 'NORMAL').label).toBe('处理中')
    const failed = trailStateMeta('FAILED', 'NORMAL', 'tool timeout; prev=failed: db locked')
    expect(failed.label).toBe('处理失败')
    // S3.5 G7：title 只带本轮原因人话（prev= 历史链不进 title，详情展开再看）
    expect(failed.title).toContain('tool timeout')
    expect(failed.title).not.toContain('prev=failed')
  })
  it('FAILED 无 note 时 title 仍成立（不显示 undefined）', () => {
    const meta = trailStateMeta('FAILED', 'URGENT', null)
    expect(meta.label).toBe('处理失败')
    expect(meta.title).not.toContain('undefined')
    expect(meta.title).toContain('URGENT')
  })
})

describe('trailLevelMeta', () => {
  it('HALT 高亮 / NORMAL 弱化', () => {
    expect(trailLevelMeta('HALT').cls).toContain('red-600')
    expect(trailLevelMeta('NORMAL').cls).toContain('stone')
    expect(trailLevelMeta('URGENT').label).toBe('URGENT')
  })
})
