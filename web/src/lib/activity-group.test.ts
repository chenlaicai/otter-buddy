import { describe, it, expect } from 'vitest'
import { groupByActivity, ACTIVITY_GAP_MS, type ActivityGroup } from './activity-group'
import type { LocalMessage } from './mappers'

/** 构造测试消息（只填分组依赖的字段） */
function msg(st: LocalMessage['st'], ts: string, id = `m-${ts}-${st}`): LocalMessage {
  return {
    id,
    st,
    si: st === 'user' ? 'user' : 'otter-1',
    content: `content of ${id}`,
    ts,
    dur: null,
  }
}

/** 相对基准时间的 ISO 时间串（偏移毫秒） */
const base = Date.parse('2026-09-01T14:00:00+08:00')
const at = (offsetMs: number) => new Date(base + offsetMs).toISOString()

describe('groupByActivity（F20260901sgpx §7 活动段派生视图）', () => {
  it('空消息流返回空数组', () => {
    expect(groupByActivity([])).toEqual([])
  })

  it('单条消息自成一段（conversation-start）', () => {
    const groups = groupByActivity([msg('user', at(0))])
    expect(groups).toHaveLength(1)
    expect(groups[0].reason).toBe('conversation-start')
    expect(groups[0].messages).toHaveLength(1)
  })

  it('otter/system 消息跟随当前段：用户提问后的獭回复不切段', () => {
    const groups = groupByActivity([
      msg('user', at(0)),
      msg('otter', at(3000)),
      msg('system', at(4000)),
      msg('otter', at(5000)),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].messages.map(m => m.st)).toEqual(['user', 'otter', 'system', 'otter'])
  })

  it('user 消息开新段（与 ensureActiveTurn 的 turn 语义对齐）', () => {
    const groups = groupByActivity([
      msg('user', at(0)),
      msg('otter', at(2000)),
      msg('user', at(10_000)),
      msg('otter', at(12_000)),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].reason).toBe('conversation-start')
    expect(groups[1].reason).toBe('user-message')
    expect(groups[1].messages.map(m => m.st)).toEqual(['user', 'otter'])
  })

  it('静默超过 ACTIVITY_GAP_MS 开新段（gap）', () => {
    const groups = groupByActivity([
      msg('otter', at(0)),
      msg('otter', at(ACTIVITY_GAP_MS + 1)),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[1].reason).toBe('gap')
  })

  it('静默未超阈值不切段（边界：恰好等于 GAP）', () => {
    const groups = groupByActivity([
      msg('otter', at(0)),
      msg('otter', at(ACTIVITY_GAP_MS)),
    ])
    expect(groups).toHaveLength(1)
  })

  it('连续多轮混合场景：段数与切分依据正确', () => {
    const groups = groupByActivity([
      msg('user', at(0), 'a1'), // conversation-start
      msg('otter', at(5000), 'a2'),
      msg('user', at(120_000), 'b1'), // user-message（间隔 < GAP）
      msg('otter', at(130_000), 'b2'),
      msg('otter', at(600_000), 'c1'), // gap（间隔 > GAP）
    ])
    expect(groups).toHaveLength(3)
    expect(groups.map(g => g.reason)).toEqual(['conversation-start', 'user-message', 'gap'])
    expect(groups.map(g => g.id)).toEqual(['a1', 'b1', 'c1'])
  })

  it('乐观消息（ts 无效）不参与间隔计算但不崩溃', () => {
    const groups = groupByActivity([
      msg('otter', at(0), 'x1'),
      { ...msg('otter', 'invalid-ts', 'x2') },
      msg('otter', at(1000), 'x3'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].messages).toHaveLength(3)
  })
})

/** ActivityGroup 类型仅被本模块导出，确保它被引用（防 dead export） */
describe('ActivityGroup 契约', () => {
  it('导出类型可赋值', () => {
    const g: ActivityGroup = { id: 'i', messages: [], startedAt: '', reason: 'gap' }
    expect(g.id).toBe('i')
  })
})
